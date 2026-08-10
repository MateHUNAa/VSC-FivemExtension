declare module 'rcon' {
  import { EventEmitter } from 'events';

  interface RconOptions {
    tcp?: boolean;
    challenge?: boolean;
  }

  class Rcon extends EventEmitter {
    constructor(host: string, port: number, password: string, options?: RconOptions);
    connect(): void;
    disconnect(): void;
    send(command: string): void;
  }

  export = Rcon;
}
