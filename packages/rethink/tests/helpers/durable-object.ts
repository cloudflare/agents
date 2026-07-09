export function getDurableObjectStub<
  T extends Rpc.DurableObjectBranded | undefined
>(namespace: DurableObjectNamespace<T>, name: string): DurableObjectStub<T> {
  return namespace.get(namespace.idFromName(name));
}
