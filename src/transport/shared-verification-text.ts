/** Fixed provider endpoint and exact recipient. No automatic retries after an
 * uncertain send. Existing project/line recipient eligibility still applies. */
export function sharedVerificationText(options: {
  origin: string;
  projectId: string;
  key: string;
  lineId: string;
  request?: typeof fetch;
}) {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("verification_origin_required");
  return async (recipient: string, code: string, idempotencyKey: string) => {
    const response = await (options.request ?? fetch)(
      `${origin.origin}/api/v1/shared-messages`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${options.key}`,
          "x-chert-project-id": options.projectId,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          line_id: options.lineId,
          recipient,
          text: `Your ClawdTime sign-in code is ${code}. It expires in five minutes. Enter it only in the ClawdTime setup you started.`,
        }),
      },
    );
    return response.status === 200;
  };
}
