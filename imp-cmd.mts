#!/usr/bin/node
import { T } from "./imp-core.mjs";
import { ImpReader } from "./imp-read.mjs";
import { impShow } from "./imp-show.mjs";
import { impEval } from "./imp-eval.mjs";
import * as readline from "readline";

let impR = new ImpReader();

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout});

async function repl() {
  for await (const line of rl) {
    try {
      impR.send(line)
      let r = impR.read()
      let e = impEval(r)
      if (e[0] !== T.NIL) console.log(impShow(e)) }
    catch (e) { console.trace(e) }}}

await repl()
