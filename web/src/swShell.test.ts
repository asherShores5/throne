import { describe, expect, it } from "vitest";
import { precacheList, routeRequest, shellCacheName, shellVersion, staleCaches } from "./swShell";

const ORIGIN = "https://throne.example";
const precached = ["/index.html", "/assets/index-abc123.js", "/icon-192.png"];
const req = (url: string, mode = "cors", method = "GET") => ({ url: new URL(url, ORIGIN).href, mode, method });

describe("routeRequest", () => {
  it("serves any same-origin page navigation from the app shell, so deep links open offline", () => {
    expect(routeRequest(req("/", "navigate"), ORIGIN, precached)).toBe("shell");
    expect(routeRequest(req("/items/42?x=1", "navigate"), ORIGIN, precached)).toBe("shell");
  });

  it("leaves the API, Cognito, config.json and non-GET requests to the network", () => {
    expect(routeRequest(req("https://abc.appsync-api.us-west-2.amazonaws.com/graphql", "cors", "POST"), ORIGIN, precached)).toBe("passthrough");
    expect(routeRequest(req("https://cognito-idp.us-west-2.amazonaws.com/", "cors", "POST"), ORIGIN, precached)).toBe("passthrough");
    expect(routeRequest(req("/config.json"), ORIGIN, precached)).toBe("passthrough");
    expect(routeRequest(req("/assets/index-abc123.js", "cors", "POST"), ORIGIN, precached)).toBe("passthrough");
    expect(routeRequest(req("https://elsewhere.example/", "navigate"), ORIGIN, precached)).toBe("passthrough");
  });

  it("serves build files from the precache, ignoring the query string", () => {
    expect(routeRequest(req("/assets/index-abc123.js"), ORIGIN, precached)).toBe("precache");
    expect(routeRequest(req("/icon-192.png?v=2", "no-cors"), ORIGIN, precached)).toBe("precache");
    expect(routeRequest(req("/assets/index-old999.js"), ORIGIN, precached)).toBe("passthrough");
  });
});

describe("precacheList", () => {
  it("lists every build file as a root path, but not the worker, the deploy-time config or source maps", () => {
    const files = ["index.html", "assets/index-abc123.js", "assets/index-def456.css", "assets/index-abc123.js.map", "sw.js", "config.json", "icon-192.png", "manifest.webmanifest"];
    expect(precacheList(files)).toEqual([
      "/assets/index-abc123.js",
      "/assets/index-def456.css",
      "/icon-192.png",
      "/index.html",
      "/manifest.webmanifest",
    ]);
  });
});

describe("shellVersion", () => {
  const build = [
    { name: "index.html", content: "<html>v1</html>" },
    { name: "assets/index-abc123.js", content: "console.log(1)" },
  ];

  it("is the same for the same build, whatever order the files come in", () => {
    expect(shellVersion(build)).toBe(shellVersion([...build].reverse()));
    expect(shellVersion(build)).toMatch(/^[0-9a-z]+$/);
  });

  it("changes when any file's content changes, even if no hashed name does (e.g. an icon)", () => {
    const iconChanged = [...build, { name: "icon-192.png", content: new Uint8Array([2]) }];
    const iconBefore = [...build, { name: "icon-192.png", content: new Uint8Array([1]) }];
    expect(shellVersion(iconChanged)).not.toBe(shellVersion(iconBefore));
    expect(shellVersion([{ ...build[0], content: "<html>v2</html>" }, build[1]])).not.toBe(shellVersion(build));
  });

  it("names one cache per version", () => {
    expect(shellCacheName("k3x9")).toBe("throne-shell-k3x9");
  });

  it("changes when a file is renamed", () => {
    expect(shellVersion([build[0], { ...build[1], name: "assets/index-zzz999.js" }])).not.toBe(shellVersion(build));
  });
});

describe("staleCaches", () => {
  it("deletes older shell caches on activate, keeping the current one and caches it doesn't own", () => {
    const keys = ["throne-shell-old1", "throne-shell-new2", "throne-shell-old3", "push-something"];
    expect(staleCaches(keys, "throne-shell-new2")).toEqual(["throne-shell-old1", "throne-shell-old3"]);
  });
});
