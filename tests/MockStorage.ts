export class MockStorage {
  public storage: Map<string, string> = new Map();
  public getItem(k: string) {
    const val = this.storage.get(k);
    return val === undefined ? null : val;
  }
  public setItem(k: string, v: string) {
    this.storage.set(k, v);
  }
  public removeItem(k: string) {
    this.storage.delete(k);
  }
}
