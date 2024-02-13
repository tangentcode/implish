#!/usr/bin/node
import { ImpReader } from "./imp-read.mjs";
import { ImpWriter } from "./imp-write.mjs";
import prompt from "prompt";

prompt.message=""

let impR = new ImpReader();
let impW = new ImpWriter();

impR.echo = function() {
  if (impR.waiting) { impR.send("\n"); impR.prompt("...") }
  else {
    console.log(impW.show(impR.read()))
    impR.prompt("imp>") }}

impR.prompt = function(msg) {
  prompt.get(msg, function(err, res) {
    if (err) console.log(err)
    else impR.send(res[msg])
    impR.echo() })}

impR.prompt("imp>")
