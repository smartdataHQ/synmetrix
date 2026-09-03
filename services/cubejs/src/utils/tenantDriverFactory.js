/**
 * Routes that issue raw datasource SQL need an instantiated driver. Cube 1.7's
 * server-level driverFactory now returns DriverConfig instead, so the real
 * server exposes the existing instance factory separately. Tests and older
 * embeddings can continue supplying cubejs.options.driverFactory.
 */
export default function tenantDriverFactory(cubejs) {
  const factory =
    cubejs?.tenantDriverFactory || cubejs?.options?.driverFactory;
  if (typeof factory !== "function") {
    throw new Error("tenant datasource driver factory is unavailable");
  }
  return factory;
}
