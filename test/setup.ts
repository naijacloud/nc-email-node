/**
 * The suite must behave the same on a laptop that happens to have Naijamail
 * credentials exported as it does in CI. A stray NAIJAMAIL_API_KEY would make
 * the "no key configured" tests pass for the wrong reason.
 */
delete process.env['NAIJAMAIL_API_KEY'];
delete process.env['NAIJAMAIL_BASE_URL'];
