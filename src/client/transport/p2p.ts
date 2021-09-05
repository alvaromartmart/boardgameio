import Peer from 'peerjs';
import type { PeerJSOption } from 'peerjs';

import { InitializeGame } from '../../core/initialize';
import { Master } from '../../master/master';
import { InMemory } from '../../server/db';
import { createMetadata } from '../../server/util';
import type {
  ChatMessage,
  CredentialedActionShape,
  Ctx,
  Game,
  PlayerID,
  State,
} from '../../types';
import { Transport } from './transport';
import type { TransportOpts } from './transport';

interface P2POpts {
  isHost?: boolean;
  peerJSOptions?: PeerJSOption;
}

interface Client {
  send: Peer.DataConnection['send'];
  metadata: {
    playerID: PlayerID;
  };
}

/** Action data sent from clients to the host. */
type ClientAction =
  | {
      type: 'update';
      args: Parameters<Master['onUpdate']>;
    }
  | {
      type: 'chat';
      args: Parameters<Master['onChatMessage']>;
    }
  | {
      type: 'sync';
      args: Parameters<Master['onSync']>;
    };

/**
 * Peer-to-peer host class, which runs a local `Master` instance
 * and sends authoratative state updates to all connected players.
 */
class P2PHost {
  private clients: Map<Client, Client> = new Map();
  private matchID: string;
  private master: Master;

  constructor({
    game,
    numPlayers = 2,
    matchID,
  }: {
    game: Game;
    numPlayers: number;
    matchID: string;
  }) {
    this.matchID = matchID;
    const db = new InMemory();
    db.createMatch(this.matchID, {
      initialState: InitializeGame({ game, numPlayers }),
      metadata: createMetadata({ game, numPlayers }),
    });

    this.master = new Master(game, db, {
      send: ({ playerID, ...data }) => {
        for (const [client] of this.clients) {
          if (client.metadata.playerID !== playerID) continue;
          client.send(data);
        }
      },
      sendAll: (data) => {
        for (const [client] of this.clients) {
          client.send(data);
        }
      },
    });
  }

  registerClient(client: Client): void {
    this.clients.set(client, client);
    this.master.onConnectionChange(
      this.matchID,
      client.metadata.playerID,
      undefined,
      true
    );
  }

  unregisterClient(client: Client): void {
    this.clients.delete(client);
    this.master.onConnectionChange(
      this.matchID,
      client.metadata.playerID,
      undefined,
      false
    );
  }

  processAction(data: ClientAction): void {
    switch (data.type) {
      case 'update':
        this.master.onUpdate(...data.args);
        break;
      case 'chat':
        this.master.onChatMessage(...data.args);
        break;
      case 'sync':
        this.master.onSync(...data.args);
        break;
    }
  }
}

class P2PTransport extends Transport {
  private peer: Peer;
  private peerJSOptions: PeerJSOption;
  private isHost: boolean;
  private game: Game;
  private emit: (data: ClientAction) => void;

  constructor({
    isHost,
    peerJSOptions = {},
    ...opts
  }: TransportOpts & P2POpts) {
    super(opts);
    this.isHost = Boolean(isHost);
    this.peerJSOptions = peerJSOptions;
    this.game = opts.game;
  }

  private namespacedPeerID(): string | undefined {
    return this.matchID
      ? `boardgameio-${this.gameName}-matchid-${this.matchID}`
      : undefined;
  }

  connect(): void {
    const hostID = this.namespacedPeerID();
    const metadata = { playerID: this.playerID };

    this.peer = new Peer(this.isHost ? hostID : undefined, this.peerJSOptions);

    if (this.isHost) {
      const host = new P2PHost({
        game: this.game,
        numPlayers: this.numPlayers,
        matchID: this.matchID,
      });

      // Process actions locally.
      this.emit = (action) => void host.processAction(action);

      // Register a local client for the host that applies updates directly to itself.
      host.registerClient({
        send: (data) => void this.clientCallback(data),
        metadata,
      });

      this.peer.on('connection', (client) => {
        host.registerClient(client);
        client.on('data', (data) => void host.processAction(data));
        client.on('close', () => void host.unregisterClient(client));
      });

      this.requestSync();
    } else {
      this.peer.on('open', () => {
        const host = this.peer.connect(hostID, { metadata });
        // Forward actions to the host.
        this.emit = (action) => void host.send(action);
        // Emit sync action when a connection to the host is established.
        host.on('open', () => void this.requestSync());
        // Apply updates received from the host.
        host.on('data', (data) => {
          this.clientCallback(data);
        });
      });
    }

    this.setConnectionStatus(true);
  }

  disconnect(): void {
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.setConnectionStatus(false);
  }

  requestSync(): void {
    if (!this.emit) return;
    this.emit({
      type: 'sync',
      args: [this.matchID, this.playerID, this.credentials, this.numPlayers],
    });
  }

  sendAction(
    state: State<any, Ctx>,
    action: CredentialedActionShape.Any
  ): void {
    if (!this.emit) return;
    this.emit({
      type: 'update',
      args: [action, state._stateID, this.matchID, this.playerID],
    });
  }

  sendChatMessage(matchID: string, chatMessage: ChatMessage): void {
    if (!this.emit) return;
    this.emit({ type: 'chat', args: [matchID, chatMessage, this.credentials] });
  }

  private resetAndReconnect(): void {
    this.disconnect();
    this.connect();
  }

  updateMatchID(id: string): void {
    this.matchID = id;
    this.resetAndReconnect();
  }

  updatePlayerID(id: string): void {
    this.playerID = id;
    this.resetAndReconnect();
  }

  updateCredentials(credentials?: string): void {
    this.credentials = credentials;
    this.resetAndReconnect();
  }
}

export function P2P(p2pOpts: P2POpts = {}) {
  return (transportOpts: TransportOpts) =>
    new P2PTransport({
      ...transportOpts,
      ...p2pOpts,
    });
}
