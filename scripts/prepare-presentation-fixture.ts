/** Disposable two-app content. Creates files only; never opens an app or grants access. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "clawdtime-presentation-"));
const folder = join(root, "ClawdTime Presentation");
await mkdir(folder, { mode: 0o700 });
for (const name of ["01 Research", "02 Drafts", "03 Approved"])
  await mkdir(join(folder, name), { mode: 0o700 });
await writeFile(
  join(folder, "Presentation Notes.txt"),
  [
    "CLAWDTIME PRESENTATION",
    "",
    "A clear view of the work",
    "",
    "1. Review the Research and Drafts folders in Finder.",
    "2. Switch to this document and focus on the next step.",
    "3. Change the heading, then return to Finder to verify a file move.",
    "",
    "NEXT STEP",
    "Prepare the local walkthrough for review.",
    "",
    "This is disposable test content. No phone call or external message is needed.",
    "",
  ].join("\n"),
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  join(folder, "01 Research", "Sample Brief.txt"),
  "Disposable sample brief for the native Finder move demonstration.\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  JSON.stringify({
    folder,
    document: join(folder, "Presentation Notes.txt"),
    intendedApps: ["com.apple.finder", "com.apple.TextEdit"],
    captureStarted: false,
    inputSubmitted: false,
  }),
);
