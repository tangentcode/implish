#!/usr/bin/node
import { T } from "./imp-core.mjs";
import { ImpReader } from "./imp-read.mjs";
import { impShow } from "./imp-show.mjs";
import { ImpEvaluator } from "./imp-eval.mjs";
import * as readline from "readline";

let impR = new ImpReader();
let impE = new ImpEvaluator();

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout});

async function repl() {
  for await (const line of rl) {
    impR.send(line)
    let r = impR.read()
    let e = impE.eval(r)
    if (e[0] !== T.NIL) console.log(impShow(e)) }}

repl()
