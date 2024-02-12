#!/usr/bin/node
import { ImpReader } from "./imp-read.mjs";
import prompt from "prompt";

prompt.message=""

let imp = new ImpReader();

imp.echo = function() {
  if (imp.waiting) { imp.prompt("...") }
  else {
    console.log(imp.read())
    imp.prompt("imp>") }}

imp.prompt = function(msg) {
  prompt.get(msg, function(err, res) {
    if (err) console.log(err)
    else imp.send(res[msg])
    imp.echo() })}

imp.prompt("imp>")
