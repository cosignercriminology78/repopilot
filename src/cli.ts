#!/usr/bin/env node
import { main } from './cli/bootstrap.js';
main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(String(error)); process.exitCode = 1; });
