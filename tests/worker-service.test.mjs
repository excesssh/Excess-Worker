import test from "node:test";
import assert from "node:assert/strict";
import {userUnit,SERVICE_NAME} from "../apps/worker/dist/service.js";

test("the systemd user unit runs the worker launcher, restarts only on failure and starts with the user's session",()=>{
  const unit=userUnit("/opt/excess/supplier/.local/bin/excess-worker");
  assert.equal(SERVICE_NAME,"excess-worker.service");
  assert.ok(unit.split("\n").includes('ExecStart="/opt/excess/supplier/.local/bin/excess-worker" run'));
  // drain and stop-now end `run` with exit 0, which must not bring it back.
  assert.ok(unit.split("\n").includes("Restart=on-failure"));
  assert.ok(unit.split("\n").includes("WantedBy=default.target"));
  assert.doesNotMatch(unit,/^User=/m,"a user unit runs as its owner; there is no User= line");
  for(const bad of ["relative/excess-worker","/opt/excess/a b/\"x","/opt/excess/$HOME/x","/opt/excess/x\n[Service]","/opt/excess/%h/x"])
    assert.throws(()=>userUnit(bad),/cannot be written into a unit file/);
});
