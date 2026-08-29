/**
 * Sending a file.
 *
 * Run: NAIJAMAIL_API_KEY=nmail_live_… npx tsx examples/attachment.ts ./invoice.pdf
 */
import { readFile } from 'node:fs/promises';
import { Naijamail } from '@naijacloud/email';

const path = process.argv[2] ?? './invoice-1024.pdf';

// You read the file, not the SDK. It accepts bytes only and never opens a path:
// an SDK that reads a caller-supplied path is an arbitrary-file-read primitive
// the moment that path comes from an HTTP request.
const pdf = await readFile(path);

const nm = new Naijamail(process.env.NAIJAMAIL_API_KEY);

const { id } = await nm.emails.send({
  from: 'Acme <billing@acme.com>',
  to: ['customer@example.com'],
  replyTo: 'support@acme.com',
  subject: 'Invoice #1024',
  html: '<p>Your invoice is attached.</p>',
  text: 'Your invoice is attached.',
  attachments: [
    {
      filename: 'invoice-1024.pdf',
      // Buffer, Uint8Array or ArrayBuffer. The SDK base64-encodes it — a caller
      // hand-encoding is a caller getting the padding wrong on one file in a
      // thousand, and a silently mangled invoice is worse than a rejected one.
      content: pdf,
      contentType: 'application/pdf',
    },
  ],
  tags: { campaign: 'invoices', env: 'production' },
});

console.log(`queued ${id} with ${pdf.byteLength} bytes attached`);
