/** Publish only an explicitly enabled service number; never derive a recipient. */
export function publicPage(html: string, phone?: string) {
  if (!phone) return html;
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    throw new Error("Public texting requires an E.164 service number.");
  const href = `sms:${phone}?body=${encodeURIComponent("Hey ClawdTime")}`;
  return html
    .replaceAll('href="#text-it" data-text-it', `href="${href}" data-sms`)
    .replace(
      /<!-- TEXT_CONTACT -->[\s\S]*?<!-- \/TEXT_CONTACT -->/,
      `<p>Text <a href="${href}" data-sms>${phone}</a> to get started. Your message opens in Messages; tap Send. If the greeting is blank, type “Hey ClawdTime.”</p><p class="micro-label">Invited testers only while we finish the pilot.</p>`,
    );
}
