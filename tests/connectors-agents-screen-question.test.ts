import { describe, expect, it } from "vitest";
import { asksAboutTheScreen } from "../connectors/agents/screen-question.js";

describe("a question about the screen as it is now", () => {
  it.each([
    "Which app is in front right now? Answer with its name only.",
    "which app is in front?",
    "what app is open right now",
    "What is the frontmost app?",
    "what's the active window?",
    "which window is focused",
    "what app am I in?",
    "what tab am I on?",
    "which tabs are open?",
    "what does this window say?",
    "What does the window say",
    "what does this page show?",
    "what does the open Stonepad document say at the top?",
    "read me this page",
    "what's on my screen?",
    "what is on the screen right now?",
    "what's in front?",
    "what am I looking at?",
    "is Mail open?",
    "Is Safari in front right now?",
    "are my Riverchat windows open?",
    "do I have Mail open?",
    "is there a Stonepad window open?",
    "what is the title of this tab?",
    "what's the title of the front window",
    "what is this tab called?",
    "Can you tell me which app is in front?",
    "hey, what does this dialog say?",
  ])("routes %j to a look", (text) => {
    expect(asksAboutTheScreen(text)).toBe(true);
  });

  it.each([
    // Status of ClawdTime's own work: the task list answers.
    "what are you working on?",
    "how's it going?",
    "is the search done yet?",
    "what did you find?",
    "what was the price?",
    "did it work?",
    "what happened with the last thing I asked?",
    // Debugging the Mac: the process level answers.
    "why is my Mac so slow right now?",
    "what's running on port 4173?",
    "is the dev server still running?",
    "what is eating all my memory?",
    "Stonepad is frozen, restart it",
    "is port 4173 open?",
    // Code: a job answers.
    "what does the README say about setup?",
    "what does the failing test say?",
    "is the pull request open?",
    "is the build open in the repo?",
    // A place in the world, not on the screen.
    "is the bakery open tonight?",
    "is the shop.example store open on Sunday?",
    // Advice, requests and small talk.
    "which app should I use for notes?",
    "what app is best for notes?",
    "open Spotify and play my Discover Weekly",
    "what's on my calendar tomorrow?",
    "can you help me with something?",
    "is it open?",
    "are you up?",
    "hmm",
    "thanks!",
    "",
  ])("leaves %j to the model", (text) => {
    expect(asksAboutTheScreen(text)).toBe(false);
  });

  it("reads nothing from a very long message", () => {
    expect(
      asksAboutTheScreen(`which app is in front? ${"a ".repeat(2000)}`),
    ).toBe(false);
  });
});
