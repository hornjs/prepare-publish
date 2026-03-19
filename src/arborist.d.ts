declare module "@npmcli/arborist" {
  export default class Arborist {
    constructor(options?: { path?: string });
    loadActual(): Promise<unknown>;
  }
}
