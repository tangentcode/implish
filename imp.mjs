#!/usr/bin/node
import { T } from "./imp-core.mjs";
import { ImpReader } from "./imp-read.mjs";
import { ImpWriter } from "./imp-write.mjs";
import { ImpEvaluator } from "./imp-eval.mjs";
import prompt from "prompt";

prompt.message=""

let impR = new ImpReader();
let impW = new ImpWriter();
let impE = new ImpEvaluator();

impR.echo = function() {
  if (impR.waiting) { impR.send("\n"); impR.prompt("...") }
  else {
    let r = impR.read()
    let e = impE.eval(r)
    if (e[0] !== T.NIL) console.log(impW.show(e))
    impR.prompt("imp>") }}

impR.prompt = function(msg) {
  prompt.get(msg, function(err, res) {
    if (err) console.log(err)
    else impR.send(res[msg])
    impR.echo() })}

impR.prompt("imp>")
