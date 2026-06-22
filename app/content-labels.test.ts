import { describe, expect, it } from "vitest";
import { decodeComments, extractManychatKeywords, normalizeCommentText } from "./content-labels.js";

const json = (comments: { username: string; text: string; likes?: number }[]) =>
  JSON.stringify(comments.map((c) => ({ likes: 0, ...c })));

describe("normalizeCommentText", () => {
  it("lowercases and strips punctuation/emoji", () => {
    expect(normalizeCommentText("Loop!!")).toBe("loop");
    expect(normalizeCommentText("🔁 Loop")).toBe("loop");
    expect(normalizeCommentText("  TRACKER  ")).toBe("tracker");
  });
});

describe("extractManychatKeywords", () => {
  it("reads the trigger word from the caption's call-to-action", () => {
    expect(extractManychatKeywords('comment “loop” and I’ll send you the setup')).toContain("loop");
    expect(extractManychatKeywords("comment 'tracker' and I'll send the full setup")).toContain("tracker");
    expect(extractManychatKeywords("DM me STACK for the linked list")).toContain("stack");
    expect(extractManychatKeywords("type the word manus to get the prompts")).toContain("manus");
  });

  it("does not treat ordinary CTA filler words as keywords", () => {
    const kws = extractManychatKeywords("comment below what you think and tag a friend");
    expect(kws.has("below")).toBe(false);
    expect(kws.has("what")).toBe(false);
  });

  it("returns an empty set for captions without a CTA", () => {
    expect(extractManychatKeywords("Here are the 5 pieces of my workflow").size).toBe(0);
    expect(extractManychatKeywords(null).size).toBe(0);
  });
});

describe("decodeComments — ManyChat filtering", () => {
  it("strips the caption keyword and the creator's auto-replies (real DZgSz_6A7So shape)", () => {
    const result = decodeComments(
      json([
        { username: "timothysok", text: "Loop" },
        { username: "chrisvannoy", text: "Loop" },
        { username: "ranikainmotion", text: "Loop" },
        { username: "damzz00", text: "Loop" },
        { username: "itsmariahbrunner", text: "just sent!! hope it's helpful :)" },
      ]),
      { caption: 'comment “loop” and I’ll send you the step-by-step :)', creatorUsername: "itsmariahbrunner" },
    );
    // Every comment is either the trigger keyword or the creator's reply → nothing left.
    expect(result).toEqual([]);
  });

  it("keeps a genuine question buried in keyword spam", () => {
    const result = decodeComments(
      json([
        { username: "a", text: "Tracker" },
        { username: "b", text: "Tracker" },
        { username: "c", text: "does this work on the free plan?", likes: 12 },
        { username: "d", text: "Tracker" },
      ]),
      { caption: 'comment "tracker" and I will send the setup', creatorUsername: "itsmariahbrunner" },
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("does this work on the free plan?");
    expect(result[0].isQuestion).toBe(true);
  });

  it("filters repeated short tokens even without a caption (repetition fingerprint)", () => {
    const result = decodeComments(
      json([
        { username: "a", text: "VA" },
        { username: "b", text: "VA" },
        { username: "c", text: "VA" },
        { username: "d", text: "This completely changed how I batch my content", likes: 30 },
      ]),
      {},
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("changed how I batch");
  });

  it("strips keyword-plus-filler variants and short typo reactions on a ManyChat reel", () => {
    const result = decodeComments(
      json([
        { username: "a", text: "Loop pls" },
        { username: "b", text: "Live please" },
        { username: "c", text: "Sauta" },
        { username: "d", text: "agentic😂" },
        { username: "e", text: "This walkthrough finally made worktrees click for me", likes: 8 },
      ]),
      { caption: 'comment "loop" for the setup', creatorUsername: "itsmariahbrunner" },
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("worktrees click");
  });

  it("never drops a long comment that merely contains the keyword as a word", () => {
    const result = decodeComments(
      json([{ username: "a", text: "this will work great for my whole team, thank you", likes: 3 }]),
      { caption: 'comment "work" and I will send the template' },
    );
    expect(result).toHaveLength(1);
  });

  it("keeps ordinary top comments and sorts questions first, then by likes", () => {
    const result = decodeComments(
      json([
        { username: "a", text: "This is so helpful, thank you!", likes: 5 },
        { username: "b", text: "what model did you use?", likes: 9 },
        { username: "c", text: "saving this for later", likes: 40 },
      ]),
      { caption: "no call to action here" },
    );
    expect(result.map((c) => c.text)).toEqual([
      "what model did you use?", // question first
      "saving this for later", // then by likes desc
      "This is so helpful, thank you!",
    ]);
  });
});
