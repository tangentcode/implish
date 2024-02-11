#!/usr/bin/node
import { Imp } from "./implish.mjs";
import prompt from "prompt";

prompt.message=""

let imp = new Imp();

imp.runTilEmpty = function() {
  while (!imp.waiting) {
    imp.scan()
    imp.apply()}
  imp.prompt()}

imp.prompt = function() {
  prompt.get("imp>", function(err, res) {
    if (err) console.log(err)
    else imp.addsrc(res["imp>"])
    imp.runTilEmpty() })}

imp.runTilEmpty()
