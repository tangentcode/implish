#!/usr/bin/node
import { ImpReader } from "./imp-read.mjs";
import * as fs from "fs";
var stdinBuffer = fs.readFileSync(0); // STDIN_FILENO = 0
console.log(stdinBuffer.toString());
