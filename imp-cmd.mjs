#!/usr/bin/node
import { T } from "./imp-core.mjs";
import { ImpReader } from "./imp-read.mjs";
import { ImpWriter } from "./imp-write.mjs";
import { ImpEvaluator } from "./imp-eval.mjs";
import * as readline from "readline";

let impR = new ImpReader();
let impW = new ImpWriter();
let impE = new ImpEvaluator();

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false });

async function repl() {
  for await (const line of rl) {
    impR.send(line)
    let r = impR.read()
    let e = impE.eval(r)
    if (e[0] !== T.NIL) console.log(impW.show(e)) }}

repl()
