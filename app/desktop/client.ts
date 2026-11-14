import { RpcWorker } from "./rpc-worker.js";

export class DatabaseClient extends RpcWorker {
  constructor(directory: string) { super(new URL("./worker.js", import.meta.url), directory, "LOCAL_DATABASE_UNAVAILABLE", "Database worker is unavailable; restart the app"); }
}
