import { describe, it, expect, vi } from "vitest";
import { makeSessionStore } from "./session-store.js";

describe("makeSessionStore (durable)", () => {
  it("loads existing data, get/set/delete persist via the write fn, and survives a 'restart'", () => {
    let backing = JSON.stringify({ alice: "ses_1" });
    const io = { read: () => backing, write: vi.fn((s: string) => { backing = s; }) };
    const s = makeSessionStore("/x/sessions.json", io);
    expect(s.get("alice")).toBe("ses_1");

    s.set("bob", "ses_2");
    expect(s.get("bob")).toBe("ses_2");
    expect(io.write).toHaveBeenCalled();
    expect(JSON.parse(backing)).toEqual({ alice: "ses_1", bob: "ses_2" });

    s.delete("alice");
    expect(s.get("alice")).toBeUndefined();
    expect(JSON.parse(backing)).toEqual({ bob: "ses_2" });

    // a fresh store over the same backing = a restart: data survives
    const s2 = makeSessionStore("/x/sessions.json", io);
    expect(s2.get("bob")).toBe("ses_2");
  });

  it("tolerates missing/corrupt backing (starts empty)", () => {
    const s = makeSessionStore("/x/sessions.json", { read: () => null, write: () => {} });
    expect(s.get("anyone")).toBeUndefined();
    const s2 = makeSessionStore("/x/sessions.json", { read: () => "not json{", write: () => {} });
    expect(s2.get("anyone")).toBeUndefined();
  });
});
