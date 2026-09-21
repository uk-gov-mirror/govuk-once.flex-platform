import { describe, expect, it } from "vitest";

import { fit, isMoreSpecific } from "./match.ts";

const fitted = (path: string, template: string) => {
  const result = fit(path, template);
  return typeof result === "string"
    ? result
    : {
        fixed: Object.fromEntries(result.fixed),
        carried: Object.fromEntries(result.carried),
      };
};

describe("fit", () => {
  it("fills a parameter that takes every remaining segment with the segments a path writes out", () => {
    expect(fitted("/v1/notifications", "/v1/{resourcePath+}")).toEqual({
      fixed: { resourcePath: "notifications" },
      carried: {},
    });
    expect(fitted("/v1/app/settings/theme", "/v1/{resourcePath+}")).toEqual({
      fixed: { resourcePath: "app/settings/theme" },
      carried: {},
    });
  });

  it("fills an ordinary parameter with one segment, and carries one the path leaves a parameter", () => {
    expect(
      fitted(
        "/v1/identity/app/{id}/linked-services",
        "/v1/identity/{serviceName}/{identifier}/linked-services",
      ),
    ).toEqual({ fixed: { serviceName: "app" }, carried: { identifier: "id" } });
  });

  it.each([
    ["/v2/notifications", "/v1/{resourcePath+}", 'its segment 1 is not "v1"'],
    [
      "/v1",
      "/v1/{resourcePath+}",
      "it has no segment for the template's last parameter",
    ],
    ["/v1/a/b", "/v1/{one}", "it has more segments than the template"],
    ["/v1", "/v1/{one}", "it has fewer segments than the template"],
    [
      "/v1/things/{id}",
      "/v1/{resourcePath+}",
      'what "{resourcePath+}" takes has to be written out, and "{id}" is a parameter',
    ],
    [
      "/v1/a/b",
      "/v1/{rest+}/b",
      '"{rest+}" takes every segment that is left, so it can only come last',
    ],
    ["/v1/{x}/b", "/v1/a/b", 'its segment 2 is not "a"'],
  ])("says why %s does not fit %s", (path, template, why) => {
    expect(fitted(path, template)).toBe(why);
  });
});

describe("isMoreSpecific", () => {
  it("puts a segment written out before a parameter, and a parameter before one that takes the rest", () => {
    expect(isMoreSpecific("/v1/sar/{sarId}", "/v1/{resourcePath+}")).toBe(true);
    expect(isMoreSpecific("/v1/{a}/{b}", "/v1/{resourcePath+}")).toBe(true);
    expect(isMoreSpecific("/v1/{resourcePath+}", "/v1/sar/{sarId}")).toBe(
      false,
    );
    expect(isMoreSpecific("/v1/{resourcePath+}", "/v1/{resourcePath+}")).toBe(
      false,
    );
    expect(isMoreSpecific("/v1/sar/{sarId}", "/v1/{a}/{b}")).toBe(true);
  });
});
