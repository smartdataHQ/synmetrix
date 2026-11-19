/**
 * Callers that ask for one appId while its CompilerApi is being built share
 * that build.
 *
 * Cube's `getCompilerApi` reads its compiler cache, awaits, then writes it
 * (server-core 1.8.16, core/server.js). Requests that resume in the same tick
 * all miss, each builds its own CompilerApi, and each of those compiles the
 * same model with its own transpile worker pool. On dev, 2026-11-19, that took
 * a pod from 0.5 to over 2 GiB within seconds and it was OOM-killed, three
 * times. Cube already shares the build this way for orchestrators.
 *
 * Nothing is kept once a build settles: a hit is in Cube's cache by then, and
 * a failure must not become the answer for the next caller.
 *
 * @param {{getCompilerApi: (context: object) => Promise<object>}} cubejs
 * @param {(context: object) => string} contextToAppId - the same function Cube
 *   keys its compiler cache with
 */
export default function shareCompilerApiBuilds(cubejs, contextToAppId) {
  const build = cubejs.getCompilerApi.bind(cubejs);
  const building = new Map();

  cubejs.getCompilerApi = (context) => {
    const appId = contextToAppId(context);
    let pending = building.get(appId);
    if (!pending) {
      pending = build(context).finally(() => building.delete(appId));
      building.set(appId, pending);
    }
    return pending;
  };
}
