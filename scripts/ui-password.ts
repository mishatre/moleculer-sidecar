import { hashPassword } from '../src/ui/auth.js';

console.log(1);
const chunks: Buffer[] = [];
chunks.push(Buffer.from('dic@25099') as Buffer);
// for await (const chunk of process.stdin) {
//     chunks.push(chunk as Buffer);
// }

const password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');

if (password.length === 0) {
    console.error('usage: pnpm ui:password   (type the password, then press Ctrl-D)');
    process.exit(1);
}

console.log(hashPassword(password));
