import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type ModelClient } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import {
  ComputerJournal,
  looksSecretStrict,
} from "../connectors/computer/journal.js";
import {
  asksWhatItCanDo,
  casualWords,
  readWords,
  readWordsAsWritten,
  spellStopWords,
  typoCount,
  typoTarget,
  type WordKind,
} from "../connectors/computer/orders.js";
import type { Action } from "../connectors/computer/ports.js";
import { ComputerWorker, stoppedText } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

/**
 * What each row proves:
 * - typo: a clear screen order with a typo, held as written, is now that order
 * - casual: a clear order or continue in a casual form, held as written, is now one
 * - stop: a stop word with a typo stops; a stop as written stays a stop
 * - near: an ordinary word near a stop word does not stop
 * - hold: a hold cue with a typo, without its apostrophe or as an emoji holds
 * - question: a question with a typo still holds
 * - remark: a remark, a refusal or a negation with a typo still holds
 * - deny: an English word near a screen word stays as written
 * - secret: words with a secret are never read into an order
 * - ability: a question about what ClawdTime can do holds; a named target does not
 * - same: the reading of today does not change
 */
type Category =
  | "typo"
  | "casual"
  | "stop"
  | "near"
  | "hold"
  | "question"
  | "remark"
  | "deny"
  | "secret"
  | "ability"
  | "same";

/** [input, the reading of today (as written), the reading now, what it proves] */
const table: readonly (readonly [string, WordKind, WordKind, Category])[] = [
  // The brief's own orders
  ["opne chrome", "hold", "order", "typo"],
  ["clik the blue button", "hold", "order", "typo"],
  ["pls scroll dwn", "hold", "order", "casual"],
  ["go to youtube.com n search cats", "order", "order", "same"],
  ["hit enter plz", "order", "order", "same"],
  ["ok so open slack", "order", "order", "same"],

  // Screen verbs with a typo
  ["Opne Chrome.", "hold", "order", "typo"],
  ["OPNE CHROME", "hold", "order", "typo"],
  ["yo, opne chrome", "hold", "order", "typo"],
  ["clikc the buton", "hold", "order", "typo"],
  ["cilck the first result", "hold", "order", "typo"],
  ["slect the last link", "hold", "order", "typo"],
  ["selcet the other tab", "hold", "order", "typo"],
  ["swich to safari", "hold", "order", "typo"],
  ["swtich to chrome", "hold", "order", "typo"],
  ["scrol down", "hold", "order", "typo"],
  ["scorll down", "hold", "order", "typo"],
  ["presss enter", "hold", "order", "typo"],
  ["pres enter", "hold", "order", "typo"],
  ["prss return", "hold", "order", "typo"],
  ["serch for cats", "hold", "order", "typo"],
  ["seach for invoices", "hold", "order", "typo"],
  ["clsoe the tab", "hold", "order", "typo"],
  ["chosoe the first one", "hold", "order", "typo"],
  ["pikc the top option", "hold", "order", "typo"],
  ["drga the icon", "hold", "order", "typo"],
  ["darg the icon", "hold", "order", "typo"],
  ["Nothing happened. Pres enter.", "hold", "order", "typo"],
  ["I dnt see it. Opne Notion.", "hold", "order", "typo"],
  ["Can you opne safari?", "hold", "order", "typo"],
  ["can u clik the send button?", "hold", "order", "typo"],
  ["can u opne it in the browser?", "hold", "order", "typo"],
  ["scroll down then clik the first one", "hold", "order", "typo"],
  ["opne it n clik login", "hold", "order", "typo"],

  // Screen nouns, keys and directions with a typo
  ["click the buton", "hold", "order", "typo"],
  ["click the buttn", "hold", "order", "typo"],
  ["tap the linkk", "hold", "order", "typo"],
  ["scroll dwon", "hold", "order", "typo"],
  ["press entr", "hold", "order", "typo"],
  ["press eneter", "hold", "order", "typo"],
  ["hit retrun", "hold", "order", "typo"],
  ["hit esacpe", "hold", "order", "typo"],
  ["press spcae", "hold", "order", "typo"],
  ["press backspcae", "hold", "order", "typo"],
  ["close the popuo", "hold", "order", "typo"],
  ["close the dialgo", "hold", "order", "typo"],
  ["type hello in the serch box", "hold", "order", "typo"],
  ["open the sidebr", "hold", "order", "typo"],
  ["open the dropdwon", "hold", "order", "typo"],
  ["click the chekbox", "hold", "order", "typo"],
  ["open the folfer", "hold", "order", "typo"],
  ["open the emial", "hold", "order", "typo"],
  ["close the windwo", "hold", "order", "typo"],
  ["click the imgae", "hold", "order", "typo"],
  ["open the vidoe", "hold", "order", "typo"],
  ["open the menuu", "hold", "order", "typo"],
  ["click the iocn", "hold", "order", "typo"],
  ["open the lsit", "hold", "order", "typo"],
  ["click the reslut", "hold", "order", "typo"],
  ["click the optoin", "hold", "order", "typo"],
  ["open the sectoin", "hold", "order", "typo"],
  ["open the toolabr", "hold", "order", "typo"],
  ["click the adress bar", "hold", "order", "typo"],

  // Known app and browser names with a typo
  ["use chrmoe", "hold", "order", "typo"],
  ["use safar", "hold", "order", "typo"],
  ["go to the setings", "hold", "order", "typo"],
  ["open sytem settings", "hold", "order", "typo"],
  ["switch to googel chrome", "hold", "order", "typo"],
  ["open the calcualtor", "hold", "order", "typo"],
  ["open it in chorme", "order", "order", "same"],
  ["switch to termnial", "order", "order", "same"],

  // Casual forms of a clear order or continue
  ["hey clawdtime open chrome", "hold", "order", "casual"],
  ["clawdtime, open safari", "hold", "order", "casual"],
  ["ClawdTime open the first link", "hold", "order", "casual"],
  ["open chrome, clawdtime", "hold", "order", "casual"],
  ["hey clawd time, scroll down", "hold", "order", "casual"],
  ["pleeease open chrome", "hold", "order", "casual"],
  ["open chrome pleaseee", "hold", "order", "casual"],
  ["open chrome \u{1F64F}", "hold", "order", "casual"],
  ["open safari \u{1F44D}", "hold", "order", "casual"],
  ["open safari \u{1F44D}\u{1F3FD}", "hold", "order", "casual"],
  ["scroll down pls \u{1F64F}\u{1F64F}", "hold", "order", "casual"],
  ["click the btn", "hold", "order", "casual"],
  ["open the msg", "hold", "order", "casual"],
  ["open the pg", "hold", "order", "casual"],
  ["click it thx", "hold", "order", "casual"],
  ["open safari thnx", "hold", "order", "casual"],
  ["click it again thx", "hold", "order", "casual"],
  ["open settings thx bro", "hold", "order", "casual"],
  ["k open chrome", "hold", "order", "casual"],
  ["kk click it", "hold", "order", "casual"],
  ["okie open the first link", "hold", "order", "casual"],
  ["aight open chrome", "hold", "order", "casual"],
  ["open youtube.com and search cats", "hold", "order", "casual"],
  ["search cats", "hold", "order", "casual"],
  ["open it w/ chrome", "hold", "order", "casual"],
  ["*click* the button", "hold", "order", "casual"],
  ["click it rn", "hold", "order", "casual"],
  ["open chrome asap", "hold", "order", "casual"],
  ["goto youtube.com", "hold", "order", "casual"],
  ["pliz open chrome?", "hold", "order", "casual"],
  ["pls opne chrome?", "hold", "order", "typo"],
  ["pls open chrome \u{2753}", "hold", "order", "casual"],
  ["kk go on", "hold", "continue", "casual"],
  ["yea continue", "hold", "continue", "casual"],
  ["yup, continue", "hold", "continue", "casual"],
  ["k continue", "hold", "continue", "casual"],
  ["continue \u{1F64F}", "hold", "continue", "casual"],
  ["continue pls \u{1F64F}", "hold", "continue", "casual"],
  ["ok so continue", "continue", "continue", "same"],
  ["open youtube.com n search cats", "order", "order", "same"],
  ["open chrome!!!!!!", "order", "order", "same"],
  ["open chrome\u{2026}", "order", "order", "same"],
  ["open chrome \u{203C}", "order", "order", "same"],
  ["plz open chrome", "order", "order", "same"],
  ["press cmd + c", "order", "order", "same"],
  ['type "u r great" in the search box', "order", "order", "same"],

  // Stop words with a typo, and stops that stay stops
  ["stpo", "hold", "stop", "stop"],
  ["sotp", "hold", "stop", "stop"],
  ["tsop", "hold", "stop", "stop"],
  ["STPO!", "hold", "stop", "stop"],
  ["sstop", "hold", "stop", "stop"],
  ["stopit", "hold", "stop", "stop"],
  ["cancle", "hold", "stop", "stop"],
  ["cancell", "hold", "stop", "stop"],
  ["cansel", "hold", "stop", "stop"],
  ["abrot", "hold", "stop", "stop"],
  ["aboart", "hold", "stop", "stop"],
  ["hlat", "hold", "stop", "stop"],
  ["stooop", "hold", "stop", "stop"],
  ["stoooooop", "hold", "stop", "stop"],
  ["STOOOOP", "hold", "stop", "stop"],
  ["caaancel", "hold", "stop", "stop"],
  ["pls stpo", "hold", "stop", "stop"],
  ["ok cancle that", "hold", "stop", "stop"],
  ["\u{1F6D1}", "hold", "stop", "stop"],
  ["\u{23F9}", "hold", "stop", "stop"],
  ["click the stpo button", "order", "stop", "stop"],
  ["stopp", "stop", "stop", "stop"],
  ["stop \u{1F914}", "stop", "stop", "stop"],
  ["can u stop?", "stop", "stop", "stop"],
  ["opne chrome. stop", "stop", "stop", "stop"],
  // One letter doubled, as in "sttop": a typo of stop that stops.
  ["stoop", "hold", "stop", "stop"],

  // Ordinary words near a stop word
  ["step", "hold", "hold", "near"],
  ["shop", "hold", "hold", "near"],
  ["atop", "hold", "hold", "near"],
  ["stow", "hold", "hold", "near"],
  ["top", "hold", "hold", "near"],
  ["stow it", "hold", "hold", "near"],
  ["atop the page", "hold", "hold", "near"],
  ["click the shop button", "order", "order", "near"],
  ["open the shop page", "order", "order", "near"],
  ["click the top one", "order", "order", "near"],
  ["click step two", "hold", "hold", "near"],

  // Hold cues with a typo, without the apostrophe, or as an emoji
  ["dont click", "hold", "hold", "hold"],
  ["scroll donw", "hold", "hold", "hold"],
  ["click it nore", "hold", "hold", "hold"],
  ["click it notr", "hold", "hold", "hold"],
  ["dnt click it", "hold", "hold", "hold"],
  ["dnt clik it", "hold", "hold", "hold"],
  ["dont opne chrome", "hold", "hold", "hold"],
  ["wiat", "hold", "hold", "hold"],
  ["wair a sec", "hold", "hold", "hold"],
  ["wiat, clik the button", "hold", "hold", "hold"],
  ["click the button, wiat", "hold", "hold", "hold"],
  ["click the button wiat", "order", "hold", "hold"],
  ["hld on", "hold", "hold", "hold"],
  ["hld on, opne chrome", "hold", "hold", "hold"],
  ["hol up", "hold", "hold", "hold"],
  ["holdon", "hold", "hold", "hold"],
  ["nvm", "hold", "hold", "hold"],
  ["nvmd", "hold", "hold", "hold"],
  ["idk", "hold", "hold", "hold"],
  ["idk, open chrome", "hold", "hold", "hold"],
  ["clik the button, idk", "hold", "hold", "hold"],
  ["dunno", "hold", "hold", "hold"],
  ["lemme do it", "hold", "hold", "hold"],
  ["gimme a sec", "hold", "hold", "hold"],
  ["im typing", "hold", "hold", "hold"],
  ["im typing. open chrome", "order", "hold", "hold"],
  ["ill do it", "hold", "hold", "hold"],
  ["brb", "hold", "hold", "hold"],
  ["afk", "hold", "hold", "hold"],
  ["1 sec", "hold", "hold", "hold"],
  // A time phrase holds as written too.
  ["click the button 1 sec", "hold", "hold", "hold"],
  ["click it, jk", "hold", "hold", "hold"],
  ["click the button jk", "order", "hold", "hold"],
  ["nooo dont", "hold", "hold", "hold"],
  ["waaait", "hold", "hold", "hold"],
  ["hoooold on", "hold", "hold", "hold"],
  ["click the link, nahhh", "hold", "hold", "hold"],
  ["click the link nahhh", "order", "hold", "hold"],
  ["click the button noo", "order", "hold", "hold"],
  ["click the button nott", "order", "hold", "hold"],
  ["click the Save button \u{1F914}", "order", "hold", "hold"],
  ["open chrome \u{1F914}", "hold", "hold", "hold"],
  ["click it \u{1F644}", "hold", "hold", "hold"],
  ["open safari \u{270B}", "hold", "hold", "hold"],
  ["click the send button \u{274C}", "order", "hold", "hold"],
  ["open chrome \u{23F3}", "hold", "hold", "hold"],

  // Questions with a typo
  ["can u opne chrome or should i?", "hold", "hold", "question"],
  ["opne chrome?", "hold", "hold", "question"],
  ["clik the button?", "hold", "hold", "question"],
  ["did u clik it?", "hold", "hold", "question"],
  ["u stuck?", "hold", "hold", "question"],
  ["open chrome?!", "order", "hold", "question"],
  ["open chrome\u{2753}", "hold", "hold", "question"],
  ["clawdtime? open chrome", "hold", "hold", "question"],

  // Remarks, refusals and negations with a typo
  ["opne chrome, its hot in here", "hold", "hold", "remark"],
  ["clik the button, that worked so well", "hold", "hold", "remark"],
  ["not yet, clik it", "hold", "hold", "remark"],
  ["nope, opne chrome", "hold", "hold", "remark"],
  ["never clik that", "hold", "hold", "remark"],
  ["opne the door for the delivery guy", "hold", "hold", "remark"],
  ["opne the email and delete all", "hold", "hold", "remark"],
  ["opne package.json", "hold", "hold", "remark"],
  ["type faster", "hold", "hold", "remark"],
  ["go bak", "hold", "hold", "remark"],

  // English words near a screen word stay as written
  ["lick it", "hold", "hold", "deny"],
  ["clock it", "hold", "hold", "deny"],
  ["clock the time", "hold", "hold", "deny"],
  ["chose the first one", "hold", "hold", "deny"],
  ["pen the note", "hold", "hold", "deny"],
  ["open the oven", "hold", "hold", "deny"],
  ["drab icon", "hold", "hold", "deny"],
  ["filed the report", "hold", "hold", "deny"],
  ["lost the tab", "hold", "hold", "deny"],
  ["typed hello in the search box", "hold", "hold", "deny"],
  ["opened chrome", "hold", "hold", "deny"],
  ["opens chrome", "hold", "hold", "deny"],
  ["clicked the button", "hold", "hold", "deny"],
  ["closed the tab", "hold", "hold", "deny"],
  ["pressed enter", "hold", "hold", "deny"],
  ["folded the note", "hold", "hold", "deny"],
  ["browse the web", "hold", "hold", "deny"],
  ["noted, open chrome", "hold", "hold", "deny"],
  ["tape the box", "hold", "hold", "deny"],
  ["pick the puck", "hold", "hold", "deny"],
  ["drown it out", "hold", "hold", "deny"],
  ["open the settings fiel", "hold", "hold", "deny"],
  ["opne the tset tab", "hold", "order", "typo"],

  // Secrets
  ["my pin is 4 8 2 1", "hold", "hold", "secret"],
  ["pw: hunter2", "hold", "hold", "secret"],
  ["my p\u{200B}in is 4821", "hold", "hold", "secret"],
  ["pass\u{200D}word: hunter2", "hold", "hold", "secret"],
  ["pin: \u{FF14}\u{FF18}\u{FF12}\u{FF11}", "hold", "hold", "secret"],
  ["my pin is 4821 thx", "hold", "hold", "secret"],
  ["my passcode is 4 8 2 1 \u{1F64F}", "hold", "hold", "secret"],
  ["use code 482913 pls", "hold", "hold", "secret"],
  ["opne chrome, my password is swordfish", "hold", "hold", "secret"],
  [
    "clik the search box and type my password hunter2",
    "hold",
    "hold",
    "secret",
  ],
  ["type 4821 as the pin in the serch box", "hold", "hold", "secret"],
  ["tpye 4821 as the pin in the search box", "hold", "hold", "secret"],

  // Questions about what ClawdTime can do
  ["Can you click buttons on my screen?", "order", "hold", "ability"],
  ["could you click buttons pls", "order", "hold", "ability"],
  ["Can you use a browser?", "order", "hold", "ability"],
  ["can u use my mac?", "hold", "hold", "ability"],
  ["are you able to open apps", "hold", "hold", "ability"],
  ["are u able to use my mac?", "hold", "hold", "ability"],
  ["can u clik buttons on my screen?", "hold", "hold", "ability"],
  ["can you click things for me?", "hold", "hold", "ability"],
  ["could you use my computer?", "hold", "hold", "ability"],
  ["can you see my screen?", "hold", "hold", "ability"],
  ["can you even type?", "hold", "hold", "ability"],
  ["do you know how to use apps on my mac?", "hold", "hold", "ability"],
  ["is it possible for you to click stuff?", "hold", "hold", "ability"],
  ["can you do stuff on my computer?", "hold", "hold", "ability"],
  ["can u control the mouse?", "hold", "hold", "ability"],
  ["can you click anything?", "hold", "hold", "ability"],
  ["Can you click the Send button?", "order", "order", "ability"],
  ["can you open the apps folder?", "order", "order", "ability"],
  ["Can you use the browser?", "order", "order", "ability"],
  ["can you open Safari?", "order", "order", "ability"],
  ["can you click it?", "order", "order", "ability"],
  ["can you open apps and click the Send button?", "order", "order", "ability"],

  // Readings of today that stay
  ["open Safari", "order", "order", "same"],
  ["click the Save button", "order", "order", "same"],
  ["go back", "order", "order", "same"],
  ["continue", "continue", "continue", "same"],
  ["continue?", "hold", "hold", "same"],
  ["ok", "hold", "hold", "same"],
  ["no", "hold", "hold", "same"],
  ["open door", "hold", "hold", "same"],
  ["press pause", "hold", "hold", "same"],
  ["click the cancel button", "stop", "stop", "same"],
  ["click Edit", "order", "order", "same"],
  ["open VS Code", "order", "order", "same"],
  ["search bar", "hold", "hold", "same"],
  ["click the search button", "order", "order", "same"],
  ["click save & close", "hold", "hold", "same"],
  ["go back pls", "hold", "hold", "same"],
];

const escalates = (today: WordKind, now: WordKind) =>
  today === "hold" && (now === "order" || now === "continue");

describe("natural words: the table", () => {
  it("holds at least 150 new cases and every category", () => {
    expect(table.length).toBeGreaterThanOrEqual(150);
    expect(new Set(table.map((row) => row[0])).size).toBe(table.length);
    const seen = new Set(table.map((row) => row[3]));
    for (const category of [
      "typo",
      "casual",
      "stop",
      "near",
      "hold",
      "question",
      "remark",
      "deny",
      "secret",
      "ability",
      "same",
    ] as const)
      expect(seen.has(category), category).toBe(true);
  });

  it.each(table)(
    "reads %j as %s as written and %s now (%s)",
    (input, today, now) => {
      expect(readWordsAsWritten(input)).toBe(today);
      expect(readWords(input)).toBe(now);
    },
  );

  it("is one way: a stop stays a stop, and only a listed typo or casual form goes from hold to order or continue", () => {
    for (const [input, today, now, category] of table) {
      const read = readWords(input);
      if (today === "stop") expect([input, read]).toEqual([input, "stop"]);
      if (escalates(today, read))
        expect([input, category]).toEqual([
          input,
          expect.stringMatching(/^(?:typo|casual)$/),
        ]);
      if (today !== read)
        expect([
          input,
          escalates(today, read) || read === "hold" || read === "stop",
        ]).toEqual([input, true]);
      expect(read).toBe(now);
    }
  });
});

describe("natural words: one way over variants", () => {
  /** Ways people type the same words. None of them adds a polite lead or takes a mark away. */
  const variants: ((text: string) => string)[] = [
    (text) => `${text} \u{1F64F}`,
    (text) => text.replace(/'/g, ""),
    (text) => text.replace(/'/g, "\u{2019}"),
    (text) =>
      text
        .replace(/\byou\b/gi, "u")
        .replace(/\band\b/g, "n")
        .replace(/\bthanks\b/gi, "thx"),
    (text) =>
      text.replace(
        /\b([b-df-hj-np-tv-z]*)([aeiou])/gi,
        (_, lead, vowel) => `${lead}${vowel.repeat(3)}`,
      ),
    (text) => (/\?\s*$/.test(text) ? `${text}??` : `${text}!!!`),
    (text) => `yo ${text}`,
    (text) => `ok so ${text}`,
    (text) => `hey clawdtime ${text}`,
    (text) => text.replace(/\s+/g, "  "),
  ];
  const seeds = table.filter(([, today]) => today !== "order");

  it("never reads a variant of a held message as an order or a continue, and keeps every stop a stop", () => {
    let checked = 0;
    for (const [input, today, now] of seeds)
      for (const variant of variants) {
        const words = variant(input);
        const read = readWords(words);
        checked++;
        if (today === "stop" || now === "stop")
          expect([words, read]).toEqual([words, "stop"]);
        else if (now === "hold")
          expect([words, read === "order" || read === "continue"]).toEqual([
            words,
            false,
          ]);
      }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("natural words: typos", () => {
  it.each([
    ["opne", "open"],
    ["oepn", "open"],
    ["clik", "click"],
    ["clikc", "click"],
    ["cilck", "click"],
    ["clicl", "click"],
    ["clickk", "click"],
    ["pres", "press"],
    ["prss", "press"],
    ["tyoe", "type"],
    ["tpye", "type"],
    ["entr", "enter"],
    ["eneter", "enter"],
    ["slect", "select"],
    ["selcet", "select"],
    ["chosoe", "choose"],
    ["choise", "choose"],
    ["pikc", "pick"],
    ["scrol", "scroll"],
    ["scorll", "scroll"],
    ["scrool", "scroll"],
    ["darg", "drag"],
    ["clsoe", "close"],
    ["clos", "close"],
    ["swich", "switch"],
    ["swtich", "switch"],
    ["serch", "search"],
    ["seach", "search"],
    ["buton", "button"],
    ["buttom", "button"],
    ["bttons", "buttons"],
    ["linkk", "link"],
    ["windwo", "window"],
    ["feild", "field"],
    ["emial", "email"],
    ["optoin", "option"],
    ["dialgo", "dialog"],
    ["folfer", "folder"],
    ["dropdwon", "dropdown"],
    ["chekbox", "checkbox"],
    ["sidebr", "sidebar"],
    ["adress", "address"],
    ["retrun", "return"],
    ["esacpe", "escape"],
    ["excape", "escape"],
    ["spcae", "space"],
    ["delte", "delete"],
    ["backspcae", "backspace"],
    ["dwon", "down"],
    ["chrmoe", "chrome"],
    ["chorme", "chrome"],
    ["crome", "chrome"],
    ["safri", "safari"],
    ["sfari", "safari"],
    ["firfox", "firefox"],
    ["googel", "google"],
    ["fidner", "finder"],
    ["termnial", "terminal"],
    ["calcualtor", "calculator"],
    ["calculatr", "calculator"],
    ["setings", "settings"],
    ["setting", "settings"],
    ["sytem", "system"],
    ["preveiw", "preview"],
    ["photo", "photos"],
  ])("reads the typo %j as %j", (typed, meant) => {
    expect(typoTarget(typed)).toBe(meant);
  });

  it("leaves short words, words of the rules, deny-list words, inflections and ties as they are", () => {
    for (const word of [
      // Shorter than 4 letters
      "opn",
      "tap",
      "hit",
      "pen",
      "tab",
      // Words of the rules
      "test",
      "from",
      "last",
      "next",
      "home",
      "mess",
      "wait",
      "hold",
      "door",
      "oven",
      "closet",
      // The deny list
      "lick",
      "clock",
      "cluck",
      "chose",
      "puck",
      "prick",
      "drab",
      "fork",
      "firm",
      "forum",
      "lost",
      "lust",
      "pave",
      "pate",
      "sire",
      "suite",
      "spite",
      "widow",
      "filed",
      "potion",
      "folded",
      "browse",
      "brace",
      "finer",
      "spade",
      "deplete",
      "noted",
      "drown",
      "daft",
      "burton",
      "calculate",
      "settling",
      "escapee",
      // Inflections and forms that tell what happened
      "opens",
      "opened",
      "opend",
      "typed",
      "types",
      "clicked",
      "clicks",
      "closer",
      "closed",
      "pressed",
      "drags",
      "picked",
      // A typo at the first letter, and English words a key away
      "vlick",
      "xlose",
      "oven",
      "tape",
      "type",
      "hype",
      "dress",
      "draw",
      "stroll",
      "elect",
      "lose",
      "mall",
      "line",
      "iron",
      // One edit from a word of holding or stopping: "dont", "not", "nope", "pause"
      "donw",
      "noet",
      "notr",
      "nore",
      "pauge",
      "pess",
      // One edit from a code word, an everyday thing or a person
      "fiel",
      "fiels",
      "biuld",
      "ovne",
      "mmom",
      // Two screen words equally near
      "messagse",
    ])
      expect([word, typoTarget(word)]).toEqual([
        word,
        word === "type" ? "type" : null,
      ]);
  });

  it("never reads a typo of a word that makes the rules hold or stop as a screen word", () => {
    const cues = (
      "not no never wait waiting hold pause paused later when after once until before unless maybe yet " +
      "nah nope nevermind forget already wrong broken mess stop cancel abort halt mind hang give second " +
      "seconds minute couple why how what should would could because dont cant wont didnt doesnt file " +
      "files test tests code project repo branch commit function component class module config script " +
      "issue bug ticket fix add write change build create push merge deploy install rename remove update " +
      "edit debug patch revert ship door box bag gate car bed book bottle closet oven package gift mom dad " +
      "mother father brother sister wife husband son boss friend faster slower"
    ).split(" ");
    const letters = "abcdefghijklmnopqrstuvwxyz";
    let checked = 0;
    for (const cue of cues) {
      const typos = new Set<string>();
      for (let i = 0; i <= cue.length; i++) {
        if (i < cue.length) typos.add(cue.slice(0, i) + cue.slice(i + 1));
        if (i + 1 < cue.length)
          typos.add(cue.slice(0, i) + cue[i + 1] + cue[i] + cue.slice(i + 2));
        for (const letter of letters) {
          typos.add(cue.slice(0, i) + letter + cue.slice(i));
          if (i < cue.length)
            typos.add(cue.slice(0, i) + letter + cue.slice(i + 1));
        }
      }
      for (const typo of typos) {
        checked++;
        const read = typoTarget(typo);
        expect([cue, typo, read === null || read === typo]).toEqual([
          cue,
          typo,
          true,
        ]);
      }
    }
    expect(checked).toBeGreaterThan(30_000);
  });

  it("counts swaps, near keys, left out and extra letters, and nothing else", () => {
    expect(typoCount("opne", "open")).toBe(1);
    expect(typoCount("oprn", "open")).toBe(1);
    expect(typoCount("opn", "open")).toBe(1);
    expect(typoCount("oppen", "open")).toBe(1);
    expect(typoCount("openn", "open")).toBe(1);
    expect(typoCount("opens", "open")).toBeGreaterThan(1);
    expect(typoCount("pen", "open")).toBeGreaterThan(1);
    expect(typoCount("oven", "open")).toBeGreaterThan(1);
    expect(typoCount("ipen", "open")).toBeGreaterThan(1);
    expect(typoCount("xopen", "open")).toBeGreaterThan(1);
    expect(typoCount("calcualtr", "calculator")).toBe(2);
  });

  it("corrects a capitalized word only where it opens a sentence", () => {
    expect(casualWords("Opne Chrome")).toBe("Open Chrome");
    expect(casualWords("click the Buton")).toBe("click the Buton");
    expect(casualWords("I see it. Clik the buton.")).toBe(
      "I see it. Click the button.",
    );
  });

  it("keeps quoted labels, web addresses and key combinations as written", () => {
    expect(casualWords('type "opne u n me" in the serch box')).toBe(
      'type "opne u n me" in the search box',
    );
    expect(casualWords("go to https://example.com/opne/clik")).toBe(
      "go to https://example.com/opne/clik",
    );
    expect(casualWords("press cmd + k")).toBe("press cmd + k");
    expect(casualWords("opne worker.ts")).toBe("open worker.ts");
    expect(readWords("opne worker.ts")).toBe("hold");
  });
});

describe("natural words: normalising never removes what the rules read", () => {
  it.each([
    ["dont click it \u{1F64F}", /\bdont\b/],
    ["not now!!!", /\bnot\b/],
    ["open chrome???", /\?$/],
    ["open chrome?!?!", /\?$/],
    ["open it in chrome \u{2753}", /\?$/],
    ["nooo", /^no$/],
    ["noo click it", /^no\b/],
    ["waitt", /^wait$/],
    ["i'm typing", /\bi'm\b/],
    ["im typing", /\bi'm\b/],
    ["never mind", /\bnever mind\b/],
    ["hold on \u{1F64F}", /\bhold on\b/],
  ])("keeps the cue in %j", (input, kept) => {
    expect(casualWords(input)).toMatch(kept);
    expect(readWords(input)).not.toMatch(/^(?:order|continue)$/);
  });
});

describe("natural words: secrets", () => {
  const secrets = [
    "my pin is 4 8 2 1",
    "my pin is 4821",
    "pw: hunter2",
    "pwd = hunter2",
    "my password is swordfish",
    "my p\u{200B}in is 4821",
    "pass\u{200D}word: hunter2",
    "my pass\u{200B}word is correct-horse-battery",
    "pin: \u{FF14}\u{FF18}\u{FF12}\u{FF11}",
    "use key sk-\u{200B}1234567890abcdefghij",
    "token ghp_abc\u{200B}defghijklmnopqrstuvw",
    "api key: mysecretvalue",
    "otp 991234",
    "use code 482913 pls",
    "type 4821 as the pin",
    "type 4821 as the pin in the serch box",
    "my passcode is 4 8 2 1 \u{1F64F}",
    "my pin is 4821 thx",
    "opne chrome, my password is swordfish",
    "pleeease type my password hunter2 in the box",
  ];

  it.each(secrets)(
    "finds the secret in %j before and after normalising",
    (words) => {
      expect(looksSecretStrict(words)).toBe(true);
      expect(looksSecretStrict(casualWords(words))).toBe(true);
      expect(readWords(words)).not.toMatch(/^(?:order|continue)$/);
    },
  );

  it("never reads a typo into an order when the words look like a secret once spelled out", () => {
    const words = "tpye 4821 as the pin in the search box";
    expect(looksSecretStrict(casualWords(words))).toBe(true);
    expect(readWordsAsWritten(words)).toBe("hold");
    expect(readWords(words)).toBe("hold");
  });

  it("changes nothing that the secret check finds in plain remarks and labels", () => {
    for (const words of [
      "the password is already filled",
      "open password generator",
      "click password recovery",
      "opne password generator",
    ]) {
      expect(looksSecretStrict(words)).toBe(false);
      expect(looksSecretStrict(casualWords(words))).toBe(false);
    }
  });
});

describe("natural words: stop words for other readers", () => {
  it("spells only the stop words out", () => {
    expect(spellStopWords("stpo")).toBe("stop");
    expect(spellStopWords("ok cancle that")).toBe("ok cancel that");
    expect(spellStopWords("stooop it")).toBe("stop it");
    expect(spellStopWords("\u{1F6D1}")).toBe("stop");
    expect(spellStopWords("opne the shop page, step 2")).toBe(
      "opne the shop page, step 2",
    );
    expect(spellStopWords('click "stpo"')).toBe('click "stpo"');
  });
});

describe("natural words: questions about what ClawdTime can do", () => {
  it.each([
    "Can you click buttons on my screen?",
    "can u use my mac?",
    "are you able to open apps",
    "Can you use my Mac?",
    "could you control my computer",
    "hey, can you actually click stuff for me?",
    "you can open apps?",
    "is it possible for you to type on my mac?",
  ])("knows %j as a question", (words) => {
    expect(asksWhatItCanDo(words)).toBe(true);
  });
  it.each([
    "Can you click the Send button?",
    "can you open Safari?",
    "can you click it?",
    "Can you use the browser?",
    "can you open the apps folder?",
    "click buttons on my screen",
    "can you open apps and click the Send button?",
    "what can you do?",
  ])("does not take %j for one", (words) => {
    expect(asksWhatItCanDo(words)).toBe(false);
  });
});

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe("natural words at the worker", () => {
  const taken = "Got it. I take that into the task that runs.";
  const heldText =
    "Got it. I hold now and take that into the task. Say continue to go on, or stop.";
  const secretText =
    "I do not take a password or a key in the chat. Type it into the field on the Mac yourself, then tell me to go on.";
  /** A task whose planner is choosing its first action, until the test lets it go on. */
  const running = async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-natural-words-"));
    roots.push(home);
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    const wait: Action = { kind: "wait", ms: 0 };
    const done: Action = { kind: "done", summary: "The note is saved." };
    const planner = new ScriptedPlanner([
      async () => {
        await gate;
        return wait;
      },
      done,
    ]);
    const hands = new FakeHands([observation([element(1, { title: "Save" })])]);
    const now = () => 1_000_000;
    const journal = new ComputerJournal(home, now);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal,
      now,
      notify: () => {},
    });
    await worker.submit("r1", "Open the editor");
    await until(() => planner.inputs.length === 1);
    return { worker, planner, journal, hands, release };
  };

  it("takes a clear order with a typo into the task, as the person wrote it", async () => {
    const { worker, planner, release } = await running();
    expect((await worker.submit("g1", "clik the blue button")).message).toBe(
      taken,
    );
    release();
    await worker.idle();
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["clik the blue button"],
    });
    expect(worker.snapshot().state).toBe("completed");
  });

  it("stops on a stop word with a typo", async () => {
    const { worker, hands, release } = await running();
    expect((await worker.submit("g1", "stpo")).message).toBe(stoppedText);
    release();
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().state).not.toBe("completed");
  });

  it("holds on a hold cue with a typo", async () => {
    const { worker, release } = await running();
    expect((await worker.submit("g1", "wiat, clik the button")).message).toBe(
      heldText,
    );
    release();
    await until(() => worker.snapshot().state === "waiting_for_person");
    worker.stop();
    await worker.idle();
  });

  it("refuses a secret in an order with a typo, and holds", async () => {
    const { worker, journal, release } = await running();
    const reply = (
      await worker.submit("g1", "type 4821 as the pin in the serch box")
    ).message;
    expect(reply).toContain(secretText);
    expect(reply).toMatch(/^I hold now, without taking those words/);
    expect(journal.guidance("r1")).toEqual([]);
    release();
    await until(() => worker.snapshot().state === "waiting_for_person");
    worker.stop();
    await worker.idle();
  });
});

describe("natural words at the hand-off", () => {
  const canDo =
    "Nothing started: that asks what I can do. I can work on this Mac's screen: open apps, click, type and scroll. Tell me what to do, and in which app.";
  function executor(state: "idle" | "running") {
    const snapshot = {
      configured: true,
      mode: "native" as const,
      state,
      canStop: state === "running",
      message:
        state === "running"
          ? 'Working on: "open the editor". Step 2 of at most 40.'
          : "No computer task runs.",
    };
    return {
      snapshot: () => snapshot,
      submit: vi.fn(async (_id: string, _text: string) => ({
        message:
          state === "running"
            ? "Got it. I take that into the task that runs."
            : "Started. I look at the screen and take one checked action at a time. Say stop to stop me.",
      })),
      answer: vi.fn(async (_text: string) => ({ message: "Answered." })),
      stop: vi.fn(() => ({
        ...snapshot,
        state: "stopping",
        canStop: false,
        message: stoppedText,
      })),
    };
  }
  function supervisor(
    execution: ReturnType<typeof executor>,
    model: ModelClient | null = null,
  ) {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-natural-hand-off-"));
    roots.push(home);
    return new Supervisor(
      {
        now: () => 1000,
        board: () => null,
        desk: new DecisionDesk(home, () => 1000),
        focus: async () => ({ ok: false }),
        send: async () => ({ ok: false, route: "none" }),
        clis: () => [],
        execution,
      },
      model,
    );
  }
  /** A model that reads every message as work for the screen and hands it over. */
  function eagerModel() {
    const reading = vi.fn(async () => ({
      intent: { kind: "none" as const },
      work: true,
    }));
    const complete = vi.fn(async () => ({
      text: "Yes, I can work on your screen.",
      toolCalls: [{ id: "a", name: "delegate_computer_task", arguments: "{}" }],
    }));
    return { reading, complete };
  }

  it.each([
    "Can you click buttons on my screen?",
    "can u use my mac?",
    "are you able to open apps",
    "could you click things on my computer?",
  ])("answers %j as a question and starts no task", async (words) => {
    const execution = executor("idle");
    const model = eagerModel();
    const reply = await supervisor(execution, model).reply([], words, "chat");
    expect(execution.submit).not.toHaveBeenCalled();
    expect(model.reading).not.toHaveBeenCalled();
    expect(reply).not.toMatch(/^Started\./);
    const bare = executor("idle");
    expect(await supervisor(bare).reply([], words, "chat")).not.toMatch(
      /^Started\./,
    );
    expect(bare.submit).not.toHaveBeenCalled();
  });

  it("answers the question in fixed words on the road before the language model", async () => {
    const execution = executor("idle");
    expect(
      await supervisor(execution).reply(
        [],
        "Can you click buttons on my screen?",
        "chat",
      ),
    ).toBe(canDo);
    expect(execution.submit).not.toHaveBeenCalled();
  });

  it("still starts a task for a request with a named target", async () => {
    const execution = executor("idle");
    const words = "Can you click the Send button?";
    await supervisor(execution).reply([], words, "chat");
    expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      words,
    );
  });

  it.each(["stpo", "cancle", "stooop", "pls stpo"])(
    "stops the running task on %j",
    async (words) => {
      const execution = executor("running");
      expect(await supervisor(execution).reply([], words, "chat")).toBe(
        stoppedText,
      );
      expect(execution.stop).toHaveBeenCalledTimes(1);
      expect(execution.submit).not.toHaveBeenCalled();
    },
  );

  it.each([
    "click the shop button",
    "clik the blue button",
    "opne it in chrome",
  ])("steers the running task with %j and does not stop it", async (words) => {
    const execution = executor("running");
    await supervisor(execution).reply([], words, "chat");
    expect(execution.stop).not.toHaveBeenCalled();
    expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      words,
    );
  });

  it("does not steer the running task with a question about what it can do", async () => {
    const execution = executor("running");
    await supervisor(execution).reply(
      [],
      "Can you click buttons on my screen?",
      "chat",
    );
    expect(execution.submit).not.toHaveBeenCalled();
    expect(execution.stop).not.toHaveBeenCalled();
  });
});

describe("a secret in casual words, while a task runs", () => {
  it("is not kept when only the casual reading shows it", async () => {
    const { looksSecretStrict } =
      await import("../connectors/computer/journal.js");
    const { casualWords } = await import("../connectors/computer/orders.js");
    const text = "tpye 4821 as the pin";
    expect(looksSecretStrict(casualWords(text))).toBe(true);
  });
});

describe("natural words: lookalike letters and typos of stops and holds", () => {
  it.each(["ѕtop іt", "STОP", "stóp", "cancél", "Srop"])(
    "stops on %j",
    (words) => {
      expect(readWords(words)).toBe("stop");
    },
  );

  it.each(["hat", "half", "stomp", "click the half price button"])(
    "does not stop on %j, a word of its own",
    (words) => {
      expect(readWords(words)).not.toBe("stop");
    },
  );

  it("spells out the stop word only, and leaves the other words as typed", () => {
    expect(spellStopWords("stоp the tеsts")).toBe("stop the tеsts");
    expect(spellStopWords("click the srop button")).toBe(
      "click the stop button",
    );
  });

  it("reads lookalike letters never less safely than the letters as typed", () => {
    // A Cyrillic е in "send": the same order as typed and as Latin letters.
    expect(readWords("click the sеnd button")).toBe("order");
    // A Cyrillic о in "not": the negation holds.
    expect(readWords("click the send button nоt the link")).toBe("hold");
    // A backtick around a label is no quoted label.
    expect(readWords("click `Send`")).toBe(readWordsAsWritten("click `Send`"));
  });

  it.each([
    "click the Today button",
    "open the 5 day forecast",
    "click the send button on monday",
    "click the send button tmrw",
    "click the send button tomorow",
    "click the send button till it loads",
    "click the send button next week",
    "click the send button at 17:30",
  ])("holds on %j", (words) => {
    expect(readWords(words)).toBe("hold");
  });

  it.each([
    "click the send button",
    "click on the 2nd result",
    "press cmd+1",
    "scroll down",
    "click the shop button",
    "opne chrome",
  ])("still reads %j as an order", (words) => {
    expect(readWords(words)).toBe("order");
  });
});
