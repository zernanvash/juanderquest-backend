// Print only the public address of the local alpha QA wallet. Never print the key.
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');

const keyPath = path.join(process.env.HOME, '.config', 'juanderquest-alpha', 'qa-wallet.key');
const privateKey = fs.readFileSync(keyPath, 'utf8').trim();
if (!/^[a-f0-9]{64}$/i.test(privateKey)) throw new Error('Invalid alpha QA wallet key file');
process.stdout.write(`${new Wallet(`0x${privateKey}`).address}\n`);
