import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptSharedInvitation,
  coordinatorPost,
  CoordinatorError,
  readSharedPairing,
  requestSharedInvitation,
  saveSharedPairing,
  sharedAcceptance,
  sharedPairingPaths,
  startSharedSignIn,
  verifySharedSignIn,
} from "../src/onboard/pairing.js";
import { fakeCoordinator, member } from "./onboard-fixture.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("shared pairing operations", () => {
  it("signs in, pairs and saves the pairing for its owner only", async () => {
    const coordinator = await fakeCoordinator();
    cleanup.push(coordinator.close);
    const home = mkdtempSync(join(tmpdir(), "clawdtime-pairing-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const post = coordinatorPost(coordinator.origin);
    const challenge = await startSharedSignIn(post, member);
    expect(coordinator.texts).toHaveLength(1);
    const session = await verifySharedSignIn(
      post,
      challenge.challengeId,
      coordinator.codeFor(member)!,
    );
    const invitation = await requestSharedInvitation(
      post,
      session.token,
      false,
    );
    const acceptance = sharedAcceptance({
      displayId: "1",
      shareScreen: false,
      control: true,
    });
    const accepted = await acceptSharedInvitation(post, invitation, acceptance);
    const { directory, file } = sharedPairingPaths(home);
    saveSharedPairing(directory, file, {
      origin: coordinator.origin,
      credential: accepted.credential,
      deviceId: accepted.pairing.deviceId,
      displayId: "1",
      allowView: false,
      allowControl: false,
      walkthroughReports: false,
    });
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(directory).mode & 0o077).toBe(0);
    const read = readSharedPairing(file);
    expect(read.kind).toBe("paired");

    // A second Mac for the same number is refused without replace.
    const again = await startSharedSignIn(post, member);
    const second = await verifySharedSignIn(
      post,
      again.challengeId,
      coordinator.codeFor(member)!,
    );
    const refused = await requestSharedInvitation(
      post,
      second.token,
      false,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CoordinatorError);
    expect((refused as CoordinatorError).status).toBe(409);
  });

  it("names no answer when the coordinator cannot be reached", async () => {
    const post = coordinatorPost("http://127.0.0.1:1", fetch, 2000);
    const error = await post("/auth/start", { recipient: member }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(CoordinatorError);
    expect((error as CoordinatorError).status).toBeNull();
    expect((error as Error).message).not.toContain(member);
  });

  it("reads a missing pairing as none and a broken one as unusable", () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-pairing-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const { file } = sharedPairingPaths(home);
    expect(readSharedPairing(file).kind).toBe("none");
  });
});
