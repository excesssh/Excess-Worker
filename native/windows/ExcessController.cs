using System;
using System.Collections.Concurrent;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Host-side AppContainer launcher for the worker controller. The controller
// can only ask the trusted parent to perform one of three typed operations.
internal static class ExcessController
{
    private const int FrameLimit = 1024 * 1024;
    private const int MaximumConcurrentRequests = 4;
    private const long MaximumInFlightBytes = 4L * 1024 * 1024;
    private const int MaximumFiles = 4096;
    private const long MaximumPackageBytes = 1024L * 1024 * 1024;
    private const uint CreateSuspended = 4, ExtendedStartupInfo = 0x80000, UnicodeEnvironment = 0x400;
    private const int SecurityCapabilitiesAttribute = 0x00020009, HandleListAttribute = 0x00020002;
    private const uint JobExtendedLimit = 9, JobKillOnClose = 0x2000, JobProcessMemory = 0x100, JobMemory = 0x200, JobActiveProcess = 8;
    private const uint ReadAccess = 0x80000000, WriteAccess = 0x40000000, ShareRead = 1, ShareWrite = 2, OpenExisting = 3, NormalAttribute = 0x80;
    private const uint WaitObject = 0, WaitTimeout = 0x102;
    private static readonly ManualResetEvent Stop = new ManualResetEvent(false);
    private static readonly object StopGate = new object();
    private static readonly BlockingCollection<string> Output = new BlockingCollection<string>(new ConcurrentQueue<string>(), 4);
    private static readonly BlockingCollection<QueuedFrame> ChildFrames = new BlockingCollection<QueuedFrame>(new ConcurrentQueue<QueuedFrame>(), 4);
    private static readonly BlockingCollection<Dictionary<string, object>> ParentFrames = new BlockingCollection<Dictionary<string, object>>(new ConcurrentQueue<Dictionary<string, object>>(), 4);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = FrameLimit, RecursionLimit = 32 };
    private static readonly ManualResetEvent OutputDone = new ManualResetEvent(false);
    private static readonly ManualResetEvent ReadyOutputDone = new ManualResetEvent(false);
    private static volatile bool OutputBroken, CleanupUnsafe;
    private static volatile string ErrorCode = "none", StopReason = "none";
    private static volatile string ChildDiagnosticCode = "NONE";
    private static readonly BoundedLineReader ControlLines = new BoundedLineReader(Console.In);
    private static string Mode, PackageDir, StateDir, ScratchRoot, ScratchSession, Origin, NodeExe, EntryFile, Scenario, TestSibling;
    private static uint TimeoutMilliseconds;
    private static uint OperationTimeoutMilliseconds = 30000;
    private static long TestResponseIdDelta;
    private static bool TestDuplicateResponse;
    private static bool DoneFrameSeen;

    private static int Main(string[] args)
    {
        StartOutput();
        bool fixture = args.Length == 1 && args[0] == "--fixture-test";
        if (args.Length > 1 || (args.Length == 1 && !fixture)) { FinalError("INVALID_LAUNCH_MODE"); FinishOutput(); return 2; }
        if (fixture) FixturePhase("main-started");
        int code = 1;
        try
        {
            string configLine;
            if (!ControlLines.ReadLine(65536, out configLine)) throw new ProtocolException("CONFIG_MISSING");
            if (fixture) FixturePhase("config-received");
            if (Encoding.UTF8.GetByteCount(configLine) > 65536) throw new ProtocolException("CONFIG_TOO_LARGE");
            var config = Parse(configLine);
            ValidateConfig(config, fixture);
            if (fixture) FixturePhase("config-validated");
            StartControlReader();
            code = Run(config, fixture);
        }
        catch (ProtocolException error) { ErrorCode = SafeCode(error.Code); }
        catch { ErrorCode = "CONTROLLER_SETUP_FAILED"; }
        FinalErrorIfNeeded();
        FinishOutput();
        return code;
    }

    private static void ValidateConfig(Dictionary<string, object> c, bool fixture)
    {
        var allowed = fixture
            ? "entrySha256,fixtureNodePath,fixtureNodeSha256,mode,nodeSha256,origin,packageDir,packageInventorySha256,scratchRoot,stateDir,stateFiles,testDuplicateResponse,testOperationTimeoutMilliseconds,testResponseIdDelta,testScenario,testSiblingPath,timeoutMilliseconds"
            : "entrySha256,mode,nodeSha256,origin,packageDir,packageInventorySha256,scratchRoot";
        if (String.Join(",", SortedKeys(c)) != allowed) throw new ProtocolException("CONFIG_KEYS_INVALID");
        if (fixture) FixturePhase("config-keys-valid");
        Mode = Text(c, "mode"); if (Mode != (fixture ? "fixture" : "production")) throw new ProtocolException("CONFIG_INVALID");
        PackageDir = Full(Text(c, "packageDir")); ScratchRoot = Full(Text(c, "scratchRoot"));
        StateDir = fixture ? Full(Text(c, "stateDir")) : null;
        if (fixture) FixturePhase("config-paths-valid");
        Origin = Text(c, "origin");
        if (String.IsNullOrEmpty(Origin) || Origin.Length > 512 || Origin.IndexOf('\r') >= 0 || Origin.IndexOf('\n') >= 0) throw new ProtocolException("CONFIG_INVALID");
        string inventoryPin = Text(c, "packageInventorySha256"), entryPin = Text(c, "entrySha256");
        RequireHash(inventoryPin); RequireHash(entryPin);
        if (fixture)
        {
            TimeoutMilliseconds = checked((uint)Integer(c, "timeoutMilliseconds"));
            if (TimeoutMilliseconds < 100 || TimeoutMilliseconds > 120000) throw new ProtocolException("CONFIG_INVALID");
            var files = c["stateFiles"] as IList;
            if (files == null || files.Count != 1 || !(files[0] is string) || (string)files[0] != "identity.json") throw new ProtocolException("STATE_ALLOWLIST_INVALID");
            FixturePhase("config-limits-valid"); FixturePhase("config-state-valid");
        }
        if (fixture)
        {
            Scenario = Text(c, "testScenario");
            if (Array.IndexOf(new[] { "echo", "malformed", "oversized", "duplicate-id", "four-inflight", "five-inflight", "long-session", "module-probe", "hang", "flood" }, Scenario) < 0) throw new ProtocolException("FIXTURE_MODE_INVALID");
            OperationTimeoutMilliseconds = checked((uint)Integer(c, "testOperationTimeoutMilliseconds"));
            if (OperationTimeoutMilliseconds < 100 || OperationTimeoutMilliseconds > 30000) throw new ProtocolException("FIXTURE_MODE_INVALID");
            object responseDelta; long delta = c.TryGetValue("testResponseIdDelta", out responseDelta) ? Convert.ToInt64(responseDelta) : 0;
            if (delta < 0 || delta > 16) throw new ProtocolException("FIXTURE_MODE_INVALID");
            bool duplicateResponse = c.ContainsKey("testDuplicateResponse") && c["testDuplicateResponse"] is bool && (bool)c["testDuplicateResponse"];
            if (c.ContainsKey("testDuplicateResponse") && !(c["testDuplicateResponse"] is bool)) throw new ProtocolException("FIXTURE_MODE_INVALID");
            TestResponseIdDelta = delta; TestDuplicateResponse = duplicateResponse;
            NodeExe = Full(Text(c, "fixtureNodePath")); RequireHash(Text(c, "fixtureNodeSha256"));
            TestSibling = Full(Text(c, "testSiblingPath"));
            EntryFile = null;
        }
        else
        {
            RequireHash(Text(c, "nodeSha256"));
            NodeExe = Path.Combine(PackageDir, "node", "node.exe");
            EntryFile = Path.Combine(PackageDir, "app", "worker", "dist", "windows-controller-entry.js");
        }
        if (IsWithin(ScratchRoot, PackageDir) || IsWithin(PackageDir, ScratchRoot) ||
            (fixture && (PackageDir == StateDir || IsWithin(PackageDir, StateDir) || IsWithin(StateDir, PackageDir) || IsWithin(StateDir, ScratchRoot) || IsWithin(ScratchRoot, StateDir))))
            throw new ProtocolException("PATHS_OVERLAP");
        RejectReparse(PackageDir); RejectReparse(ScratchRoot); if (fixture) RejectReparse(StateDir);
        if (fixture) { RejectReparse(TestSibling); if (IsWithin(PackageDir, TestSibling) || IsWithin(StateDir, TestSibling) || !File.Exists(TestSibling)) throw new ProtocolException("FIXTURE_PATH_INVALID"); }
    }

    private static int Run(Dictionary<string, object> config, bool fixture)
    {
        var acl = new AclLease(); var heldFiles = new List<FileStream>();
        IntPtr sidPtr = IntPtr.Zero, job = IntPtr.Zero, process = IntPtr.Zero, thread = IntPtr.Zero;
        IntPtr childIn = IntPtr.Zero, hostIn = IntPtr.Zero, hostOut = IntPtr.Zero, childOut = IntPtr.Zero, childErrRead = IntPtr.Zero, childErrWrite = IntPtr.Zero;
        bool profileCreated = false, assigned = false, reaped = true, profileRemoved = false, scratchRemoved = false, aclRestored = false;
        string profileName = "Excess.Worker.Controller." + Guid.NewGuid().ToString("N");
        StreamWriter toChild = null; StreamReader fromChild = null; Thread reader = null, childWriter = null, diagnosticReader = null;
        var childReplies = new BlockingCollection<ReplyFrame>(new ConcurrentQueue<ReplyFrame>(), MaximumConcurrentRequests);
        var childCompleted = new BlockingCollection<long>(new ConcurrentQueue<long>(), MaximumConcurrentRequests);
        var pending = new Dictionary<long, PendingOperation>(); var outstandingCosts = new Dictionary<long, long>(); var pendingReplyTimes = new Dictionary<long, Stopwatch>();
        long lastId = 0, inFlightBytes = 0, peakInFlightBytes = 0; int outstandingCount = 0, peakInFlightRequests = 0;
        Mutex transaction = new Mutex(false, "Local\\Excess.Worker.ControllerAclLeaseV1");
        bool transactionHeld = false;
        try
        {
            if (fixture) FixturePhase("mutex-wait");
            if (!transaction.WaitOne(30000)) throw new ProtocolException("ACL_TRANSACTION_TIMEOUT"); transactionHeld = true;
            if (fixture) FixturePhase("mutex-acquired");
            ValidateOwnedDirectory(PackageDir, true); ValidateOwnedDirectory(ScratchRoot, true);
            if (fixture) ValidateOwnedDirectory(StateDir, true);
            if (fixture) FixturePhase("directories-validated");
            VerifyPackage(config, fixture, heldFiles);
            if (fixture) FixturePhase("package-verified");
            string statePath = fixture ? Path.Combine(StateDir, "identity.json") : null;
            if (fixture) { HoldExactFile(statePath, heldFiles); FixturePhase("state-verified"); }
            ScratchSession = Path.Combine(ScratchRoot, "session-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(ScratchSession); RejectReparse(ScratchSession);
            if (fixture) FixturePhase("scratch-created");

            IntPtr createdSid;
            int profileResult = CreateAppContainerProfile(profileName, "EXCESS Controller", "Restricted worker controller", IntPtr.Zero, 0, out createdSid);
            if (profileResult != 0 || createdSid == IntPtr.Zero) throw new ProtocolException("APPCONTAINER_CREATE_FAILED");
            sidPtr = createdSid; profileCreated = true;
            if (fixture) FixturePhase("profile-created");
            var sid = new SecurityIdentifier(sidPtr);
            GrantPackageTree(acl, sid);
            if (fixture) FixturePhase("package-granted");
            if (fixture) { acl.GrantDirectory(StateDir, sid, FileSystemRights.Traverse, false); acl.GrantFile(statePath, sid, FileSystemRights.Read); FixturePhase("state-granted"); }
            acl.GrantDirectory(ScratchSession, sid, fixture ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute, true);
            if (fixture) FixturePhase("scratch-granted");

            job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new ProtocolException("JOB_CREATE_FAILED");
            SetJobLimits(job, 512UL * 1024 * 1024, 1);
            CreatePipe(out childIn, out hostIn); CreatePipe(out hostOut, out childOut);
            if (!SetHandleInformation(hostIn, 1, 0) || !SetHandleInformation(hostOut, 1, 0)) throw new ProtocolException("PIPE_SETUP_FAILED");
            CreatePipe(out childErrRead, out childErrWrite);
            if (!SetHandleInformation(childErrRead, 1, 0)) throw new ProtocolException("PIPE_SETUP_FAILED");
            var start = new StartupInfoEx(); start.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx)); start.StartupInfo.Flags = 0x100;
            start.StartupInfo.StdInput = childIn; start.StartupInfo.StdOutput = childOut; start.StartupInfo.StdError = childErrWrite;
            IntPtr attributes = IntPtr.Zero, security = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
            try
            {
                IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                attributes = Marshal.AllocHGlobal(size); if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new ProtocolException("PROCESS_ATTRIBUTES_FAILED");
                start.AttributeList = attributes;
                var caps = new SecurityCapabilities { AppContainerSid = sidPtr, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
                security = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities))); Marshal.StructureToPtr(caps, security, false);
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(SecurityCapabilitiesAttribute), security, (IntPtr)Marshal.SizeOf(typeof(SecurityCapabilities)), IntPtr.Zero, IntPtr.Zero)) throw new ProtocolException("PROCESS_ATTRIBUTES_FAILED");
                handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handles, 0, childIn); Marshal.WriteIntPtr(handles, IntPtr.Size, childOut); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, childErrWrite);
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(HandleListAttribute), handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new ProtocolException("PROCESS_ATTRIBUTES_FAILED");
                environment = Marshal.StringToHGlobalUni(BuildEnvironment(ScratchSession, PackageDir, Origin, StateDir, fixture));
                string command = Quote(NodeExe) + " " + ChildArguments(fixture);
                var info = new ProcessInformation();
                if (!CreateProcess(NodeExe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended | ExtendedStartupInfo | UnicodeEnvironment, environment, ScratchSession, ref start, out info)) throw new ProtocolException("CONTROLLER_PROCESS_START_FAILED");
                process = info.Process; thread = info.Thread;
                if (fixture) FixturePhase("process-created");
            }
            finally
            {
                if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
                if (security != IntPtr.Zero) Marshal.FreeHGlobal(security); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles); if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
            Close(childErrWrite); childErrWrite = IntPtr.Zero;
            IntPtr diagnosticHandle = childErrRead; childErrRead = IntPtr.Zero;
            diagnosticReader = new Thread(() => DrainChildStderr(new FileStream(new SafeFileHandle(diagnosticHandle, false), FileAccess.Read, 4096)));
            diagnosticReader.IsBackground = true; diagnosticReader.Name = "controller-child-diagnostic"; diagnosticReader.Start();
            Close(childIn); childIn = IntPtr.Zero; Close(childOut); childOut = IntPtr.Zero;
            if (!AssignProcessToJobObject(job, process)) throw new ProtocolException("JOB_ASSIGN_FAILED"); assigned = true;
            if (fixture) FixturePhase("job-assigned");
            if (ResumeThread(thread) == 0xffffffff) throw new ProtocolException("PROCESS_RESUME_FAILED");
            if (fixture) FixturePhase("child-resumed");
            toChild = new StreamWriter(new FileStream(new SafeFileHandle(hostIn, false), FileAccess.Write, 4096), new UTF8Encoding(false)); hostIn = IntPtr.Zero; toChild.AutoFlush = true;
            fromChild = new StreamReader(new FileStream(new SafeFileHandle(hostOut, false), FileAccess.Read, 4096), new UTF8Encoding(false)); hostOut = IntPtr.Zero;
            childWriter = new Thread(() => WriteChildReplies(toChild, childReplies, childCompleted)); childWriter.IsBackground = true; childWriter.Name = "controller-child-replies"; childWriter.Start();
            reader = new Thread(() => ReadChild(fromChild)); reader.IsBackground = true; reader.Name = "controller-child-frames"; reader.Start();
            TryOutput("{\"type\":\"ready\",\"pid\":" + GetProcessId(process).ToString() + "}");
            if (fixture) FixturePhase("ready-sent");
            if (fixture && Scenario == "flood")
            {
                // The hostile fixture starts only after readiness has reached
                // the parent pipe; optional startup diagnostics cannot erase it.
                if (!ReadyOutputDone.WaitOne(2000)) RequestStop("output-backpressure");
                for (int i = 0; i < 100000 && !Stop.WaitOne(0); i++) TryOutput("{\"type\":\"pulse\",\"sequence\":" + i.ToString() + "}");
            }
            Stopwatch session = Stopwatch.StartNew();
            while (WaitForSingleObject(process, 0) != WaitObject && !Stop.WaitOne(0))
            {
                if (fixture && session.ElapsedMilliseconds > TimeoutMilliseconds) { RequestStop("timeout"); break; }
                long completedId;
                while (childCompleted.TryTake(out completedId))
                {
                    long cost; if (outstandingCosts.TryGetValue(completedId, out cost)) { inFlightBytes -= cost; outstandingCosts.Remove(completedId); pendingReplyTimes.Remove(completedId); outstandingCount--; }
                }
                bool operationExpired = false;
                foreach (PendingOperation operation in pending.Values) if (operation.Clock.ElapsedMilliseconds > OperationTimeoutMilliseconds) { operationExpired = true; break; }
                if (!operationExpired) foreach (Stopwatch clock in pendingReplyTimes.Values) if (clock.ElapsedMilliseconds > OperationTimeoutMilliseconds) { operationExpired = true; break; }
                if (operationExpired) { RequestStop("timeout", "OPERATION_TIMEOUT"); break; }
                QueuedFrame queuedFrame;
                if (ChildFrames.TryTake(out queuedFrame, 25))
                {
                    Dictionary<string, object> frame = queuedFrame.Value;
                    string type = Text(frame, "type");
                    if (type == "done" && frame.Count == 1)
                    {
                        Stopwatch completionWait = Stopwatch.StartNew();
                        while (outstandingCount != 0 && completionWait.ElapsedMilliseconds < OperationTimeoutMilliseconds)
                        {
                            long finishedId; if (!childCompleted.TryTake(out finishedId, 25)) continue;
                            long cost; if (!outstandingCosts.TryGetValue(finishedId, out cost)) { RequestStop("protocol-error", "CHILD_COMPLETION_UNKNOWN"); break; }
                            inFlightBytes -= cost; outstandingCosts.Remove(finishedId); pendingReplyTimes.Remove(finishedId); outstandingCount--;
                        }
                        if (DoneFrameSeen || pending.Count != 0 || outstandingCount != 0)
                        { RequestStop("protocol-error", "CHILD_DONE_WITH_PENDING"); break; }
                        DoneFrameSeen = true; continue;
                    }
                    if (DoneFrameSeen) { RequestStop("protocol-error", "CHILD_FRAME_INVALID"); break; }
                    if (type != "request" || !ValidRequest(frame, lastId)) { RequestStop("protocol-error", "CHILD_FRAME_INVALID"); break; }
                    long id = Integer(frame, "id"); lastId = id;
                    if (outstandingCount >= MaximumConcurrentRequests) { RequestStop("protocol-error", "IN_FLIGHT_LIMIT"); break; }
                    long requestBytes = queuedFrame.Bytes;
                    if (requestBytes > FrameLimit || inFlightBytes + requestBytes > MaximumInFlightBytes) { RequestStop("protocol-error", "IN_FLIGHT_BUDGET_EXCEEDED"); break; }
                    pending.Add(id, new PendingOperation(requestBytes)); outstandingCosts.Add(id, requestBytes); outstandingCount++; inFlightBytes += requestBytes;
                    if (outstandingCount > peakInFlightRequests) peakInFlightRequests = outstandingCount;
                    if (inFlightBytes > peakInFlightBytes) peakInFlightBytes = inFlightBytes;
                    string outbound = "{\"type\":\"request\",\"id\":" + id.ToString() + ",\"op\":\"" + Text(frame, "op") + "\",\"payload\":" + Json.Serialize(frame["payload"]) + "}";
                    if (Encoding.UTF8.GetByteCount(outbound) > FrameLimit) { RequestStop("protocol-error", "CHILD_FRAME_INVALID"); break; }
                    TryOutput(outbound);
                }
                Dictionary<string, object> response;
                while (!Stop.WaitOne(0) && ParentFrames.TryTake(out response))
                {
                    long id = Integer(response, "id"); PendingOperation operation;
                    if (!pending.TryGetValue(id, out operation) || !ValidResponse(response, id)) { RequestStop("protocol-error", "PARENT_RESPONSE_INVALID"); break; }
                    string childResponse = Json.Serialize(response); long responseBytes = Encoding.UTF8.GetByteCount(childResponse);
                    long nextBytes = inFlightBytes - operation.RequestBytes + responseBytes;
                    if (nextBytes > MaximumInFlightBytes) { RequestStop("protocol-error", "IN_FLIGHT_BUDGET_EXCEEDED"); break; }
                    pending.Remove(id); inFlightBytes = nextBytes; outstandingCosts[id] = responseBytes; pendingReplyTimes[id] = Stopwatch.StartNew();
                    if (inFlightBytes > peakInFlightBytes) peakInFlightBytes = inFlightBytes;
                    if (!childReplies.TryAdd(new ReplyFrame(id, childResponse, responseBytes), 0)) { RequestStop("protocol-error", "CHILD_RESPONSE_QUEUE_FULL"); break; }
                }
            }
            if (Stop.WaitOne(0)) reaped = TerminateJobAndWait(job, process, StopReason == "timeout" ? 124U : 125U);
            else reaped = WaitForSingleObject(process, 5000) == WaitObject;
            if (!reaped) CleanupUnsafe = true;
            if (reader != null) reader.Join(1000); if (diagnosticReader != null) diagnosticReader.Join(2000);
            long completedAfterReap; while (childCompleted.TryTake(out completedAfterReap))
            { long cost; if (outstandingCosts.TryGetValue(completedAfterReap, out cost)) { inFlightBytes -= cost; outstandingCosts.Remove(completedAfterReap); outstandingCount--; } }
            QueuedFrame trailing;
            while (ChildFrames.TryTake(out trailing))
            {
                if (Stop.WaitOne(0)) continue;
                if (Text(trailing.Value, "type") == "done" && trailing.Value.Count == 1 && !DoneFrameSeen) DoneFrameSeen = true;
                else RequestStop("protocol-error", "CHILD_FRAME_INVALID");
            }
            uint childExit = 1; GetExitCodeProcess(process, out childExit);
            if (StopReason == "none" && !DoneFrameSeen && ErrorCode == "none") ErrorCode = childExit != 0 && ChildDiagnosticCode != "NONE" ? ChildDiagnosticCode : "CHILD_COMPLETION_MISSING";
            DiscardOutput(); TryOutput("{\"type\":\"status\",\"pid\":" + GetProcessId(process) + ",\"exitCode\":" + childExit + ",\"reaped\":" + (reaped ? "true" : "false") + ",\"termination\":\"" + SafeCode(StopReason) + "\",\"errorCode\":\"" + SafeCode(ErrorCode == "none" ? "NONE" : ErrorCode) + "\",\"peakInFlightRequests\":" + peakInFlightRequests.ToString() + ",\"peakInFlightBytes\":" + peakInFlightBytes.ToString() + "}");
            return reaped && ErrorCode == "none" ? (int)childExit : 1;
        }
        catch (ProtocolException e) { ErrorCode = SafeCode(e.Code); return 1; }
        catch { ErrorCode = "CONTROLLER_OPERATION_FAILED"; return 1; }
        finally
        {
            if (process != IntPtr.Zero && !assigned && !TerminateAndWaitProcess(process, 126)) reaped = false;
            if (job != IntPtr.Zero) { if (!TerminateJobAndWait(job, process, 126)) reaped = false; CloseHandle(job); }
            Close(childIn); Close(childOut); Close(hostIn); Close(hostOut); Close(childErrRead); Close(childErrWrite);
            try { childReplies.CompleteAdding(); } catch { }
            if (toChild != null) toChild.Dispose(); if (fromChild != null) fromChild.Dispose();
            if (childWriter != null) childWriter.Join(1000); if (reader != null) reader.Join(1000); if (diagnosticReader != null) diagnosticReader.Join(1000);
            Close(thread); Close(process);
            if (reaped && !CleanupUnsafe)
            {
                aclRestored = acl.Restore(); scratchRemoved = RemoveScratch(ScratchSession);
                profileRemoved = !profileCreated || DeleteAppContainerProfile(profileName) == 0;
            }
            foreach (FileStream file in heldFiles) try { file.Dispose(); } catch { }
            if (sidPtr != IntPtr.Zero) FreeSid(sidPtr);
            if (transactionHeld) { transaction.ReleaseMutex(); transactionHeld = false; } transaction.Dispose();
            bool clean = reaped && !CleanupUnsafe && aclRestored && scratchRemoved && profileRemoved;
            TryOutput(clean ? "{\"type\":\"cleanup\",\"ok\":true}" : "{\"type\":\"cleanup\",\"ok\":false}");
        }
    }

    private static void VerifyPackage(Dictionary<string, object> c, bool fixture, List<FileStream> held)
    {
        if (fixture)
        {
            HoldPinnedFile(NodeExe, Text(c, "fixtureNodeSha256"), held); return;
        }
        string inventoryPath = Path.Combine(PackageDir, "SHA256SUMS.txt");
        var inventoryStream = new FileStream(inventoryPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        held.Add(inventoryStream);
        if (inventoryStream.Length < 1 || inventoryStream.Length > 1024 * 1024) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
        byte[] bytes = new byte[(int)inventoryStream.Length];
        int readTotal = 0; while (readTotal < bytes.Length) { int count = inventoryStream.Read(bytes, readTotal, bytes.Length - readTotal); if (count == 0) break; readTotal += count; }
        if (readTotal != bytes.Length) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
        if (Hash(bytes) != Text(c, "packageInventorySha256")) throw new ProtocolException("PACKAGE_PIN_INVALID");
        var expected = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string text = new UTF8Encoding(false, true).GetString(bytes);
        if (!text.EndsWith("\n")) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
        foreach (string line in text.Substring(0, text.Length - 1).Split('\n'))
        {
            int split = line.IndexOf("  ", StringComparison.Ordinal);
            if (split != 64 || line.Length <= 66) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
            string hash = line.Substring(0, split), name = line.Substring(split + 2).Replace('/', '\\');
            RequireHash(hash); if (Path.IsPathRooted(name) || name.Split('\\').Length == 0 || name.Split('\\').Length > 32) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
            foreach (string part in name.Split('\\')) if (part == ".." || part == "." || part.Length == 0) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
            if (name.Equals("SHA256SUMS.txt", StringComparison.OrdinalIgnoreCase) || expected.ContainsKey(name)) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
            expected.Add(name, hash); if (expected.Count > MaximumFiles) throw new ProtocolException("PACKAGE_SIZE_LIMIT");
        }
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long total = 0;
        WalkPackage(PackageDir, PackageDir, expected, seen, held, ref total);
        if (seen.Count != expected.Count) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
        string nodePin, entryPin;
        if (!expected.TryGetValue("node\\node.exe", out nodePin) || nodePin != Text(c, "nodeSha256") ||
            !expected.TryGetValue("app\\worker\\dist\\windows-controller-entry.js", out entryPin) || entryPin != Text(c, "entrySha256"))
            throw new ProtocolException("PACKAGE_PIN_INVALID");
    }

    private static void WalkPackage(string root, string directory, Dictionary<string, string> expected, HashSet<string> seen, List<FileStream> held, ref long total)
    {
        foreach (string child in Directory.GetDirectories(directory))
        {
            RejectReparse(child); WalkPackage(root, child, expected, seen, held, ref total);
        }
        foreach (string path in Directory.GetFiles(directory))
        {
            RejectReparse(path); string name = path.Substring(root.TrimEnd('\\').Length + 1);
            if (name.Equals("SHA256SUMS.txt", StringComparison.OrdinalIgnoreCase)) continue;
            string expectedHash; if (!expected.TryGetValue(name, out expectedHash) || !seen.Add(name)) throw new ProtocolException("PACKAGE_INVENTORY_INVALID");
            var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                if (stream.Length < 0 || stream.Length > 128L * 1024 * 1024 || (total += stream.Length) > MaximumPackageBytes || Hash(stream) != expectedHash) throw new ProtocolException("PACKAGE_FILE_INVALID");
                stream.Position = 0; held.Add(stream);
            }
            catch { stream.Dispose(); throw; }
        }
    }

    private static void HoldPinnedFile(string path, string expected, List<FileStream> held)
    {
        RequireHash(expected); RejectReparse(path);
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try { if (stream.Length < 1 || stream.Length > 128L * 1024 * 1024 || Hash(stream) != expected) throw new ProtocolException("PINNED_FILE_INVALID"); stream.Position = 0; held.Add(stream); }
        catch { stream.Dispose(); throw; }
    }

    private static void GrantPackageTree(AclLease lease, SecurityIdentifier sid)
    {
        var dirs = new List<string>(); var files = new List<string>(); dirs.Add(PackageDir);
        for (int i = 0; i < dirs.Count; i++)
        {
            string dir = dirs[i]; foreach (string sub in Directory.GetDirectories(dir)) { RejectReparse(sub); dirs.Add(sub); }
            foreach (string file in Directory.GetFiles(dir)) { RejectReparse(file); if (!file.Equals(Path.Combine(PackageDir, "SHA256SUMS.txt"), StringComparison.OrdinalIgnoreCase)) files.Add(file); }
        }
        foreach (string dir in dirs) lease.GrantDirectory(dir, sid, FileSystemRights.Traverse | FileSystemRights.ReadAttributes, false);
        foreach (string file in files) lease.GrantFile(file, sid, file.Equals(NodeExe, StringComparison.OrdinalIgnoreCase) ? FileSystemRights.ReadAndExecute : FileSystemRights.Read);
    }

    private static void RequestStop(string reason, string code = null)
    {
        // Shutdown can break pipes and leave queued frames behind. Keep the
        // first stop diagnosis instead of replacing it with cleanup fallout.
        lock (StopGate)
        {
            if (Stop.WaitOne(0)) return;
            if (code != null && ErrorCode == "none") ErrorCode = code;
            StopReason = reason;
            Stop.Set();
        }
    }

    private static void ReadChild(StreamReader reader)
    {
        try
        {
            string line; var lines = new BoundedLineReader(reader);
            while (lines.ReadLine(FrameLimit, out line))
            {
                var frame = Parse(line); if (!ChildFrames.TryAdd(new QueuedFrame(frame, Encoding.UTF8.GetByteCount(line)))) { RequestStop("protocol-error", "CHILD_QUEUE_FULL"); return; }
            }
            // EOF is handled by the process watcher; a successful child may close
            // immediately after placing its terminal frame in the bounded queue.
        }
        catch { RequestStop("protocol-error", "CHILD_FRAME_INVALID"); }
    }

    private static void WriteChildReplies(StreamWriter writer, BlockingCollection<ReplyFrame> replies, BlockingCollection<long> completed)
    {
        try
        {
            foreach (ReplyFrame reply in replies.GetConsumingEnumerable())
            {
                writer.WriteLine(reply.Line); writer.Flush();
                if (!completed.TryAdd(reply.Id, 0)) throw new ProtocolException("CHILD_COMPLETION_QUEUE_FULL");
            }
        }
        catch { RequestStop("protocol-error", "CHILD_INPUT_FAILED"); }
    }

    private static void DrainChildStderr(Stream stream)
    {
        var captured = new MemoryStream(); byte[] buffer = new byte[4096];
        try
        {
            int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                int keep = (int)Math.Min(count, Math.Max(0, 65536 - captured.Length));
                if (keep > 0) captured.Write(buffer, 0, keep);
            }
            string text = Encoding.UTF8.GetString(captured.ToArray()).ToUpperInvariant();
            if (text.Contains("ERR_MODULE_NOT_FOUND") || text.Contains("CANNOT FIND MODULE")) ChildDiagnosticCode = "NODE_MODULE_NOT_FOUND";
            else if (text.Contains("EACCES") || text.Contains("EPERM") || text.Contains("ACCESS IS DENIED")) ChildDiagnosticCode = "NODE_ACCESS_DENIED";
            else if (text.Contains("ERR_UNKNOWN_FILE_EXTENSION") || text.Contains("ERR_REQUIRE_ESM")) ChildDiagnosticCode = "NODE_MODULE_FORMAT";
            else if (text.Length != 0) ChildDiagnosticCode = "NODE_STARTUP_DIAGNOSTIC";
        }
        catch { ChildDiagnosticCode = "NODE_DIAGNOSTIC_UNAVAILABLE"; }
        finally { try { stream.Dispose(); } catch { } captured.Dispose(); Array.Clear(buffer, 0, buffer.Length); }
    }

    private static void StartControlReader()
    {
        var thread = new Thread(() =>
        {
            try
            {
                string line;
                while (ControlLines.ReadLine(FrameLimit, out line))
                {
                    if (line == "{\"type\":\"stop\"}") { RequestStop("stop"); return; }
                    var frame = Parse(line);
                    if (Text(frame, "type") != "response" || !ParentFrames.TryAdd(frame)) { RequestStop("protocol-error", "PARENT_FRAME_INVALID"); return; }
                }
                RequestStop("parent-eof");
            }
            catch { RequestStop("protocol-error", "PARENT_FRAME_INVALID"); }
        }); thread.IsBackground = true; thread.Name = "controller-parent-control"; thread.Start();
    }

    private static string ChildArguments(bool fixture)
    {
        if (fixture)
        {
            if (Scenario == "module-probe") return "--preserve-symlinks-main " + Quote(Path.Combine(PackageDir, "modules", "probe.mjs"));
            string code = FixtureCode(Scenario);
            return "-e " + Quote(code);
        }
        return "--preserve-symlinks-main " + Quote(EntryFile);
    }

    private static string FixtureCode(string scenario)
    {
        if (scenario == "malformed") return "process.stdout.write('not-json\\n');setTimeout(()=>{},30000);";
        if (scenario == "oversized") return "process.stdout.write('X'.repeat(1048600)+'\\n');setTimeout(()=>{},30000);";
        if (scenario == "duplicate-id") return "process.stdout.write(JSON.stringify({type:'request',id:1,op:'adapter',payload:{text:'one'}})+'\\n'+JSON.stringify({type:'request',id:1,op:'adapter',payload:{text:'replay'}})+'\\n');setTimeout(()=>{},30000);";
        if (scenario == "module-probe") return @"(async()=>{const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),root=process.env.EXCESS_CONTROLLER_PACKAGE,target=path.join(root,'modules','probe.mjs'),missing=path.join(root,'modules','missing.mjs');const steps=[];const mark=(name,run)=>{try{run();steps.push(name+':OK')}catch(error){steps.push(name+':'+(['EACCES','EPERM'].includes(error.code)?'DENIED':error.code==='ENOENT'?'MISSING':'FAILED'))}};mark('cwd',()=>process.cwd());mark('stat',()=>fs.statSync(target));mark('realpath',()=>fs.realpathSync(target));mark('open',()=>{const fd=fs.openSync(target,'r');fs.closeSync(fd)});mark('list',()=>fs.readdirSync(path.dirname(target)));mark('missing-stat',()=>fs.statSync(missing));mark('missing-open',()=>{const fd=fs.openSync(missing,'r');fs.closeSync(fd)});try{await import(pathToFileURL(missing).href);steps.push('missing-import:OK')}catch(error){steps.push('missing-import:'+(['EACCES','EPERM'].includes(error.code)?'DENIED':error.code==='ERR_MODULE_NOT_FOUND'?'MISSING':'FAILED'))}try{await import(pathToFileURL(target).href);steps.push('import:OK')}catch(error){steps.push('import:'+(['EACCES','EPERM'].includes(error.code)?'DENIED':'FAILED'))}process.stdout.write(JSON.stringify({type:'request',id:1,op:'adapter',payload:{text:steps.join(',')}})+'\n');let b='';process.stdin.on('data',chunk=>{b+=chunk.toString();const n=b.indexOf('\n');if(n<0)return;const reply=JSON.parse(b.slice(0,n));if(reply.type!=='response'||reply.id!==1||reply.ok!==true||reply.payload!=='probe-ack')process.exit(3);process.stdout.write(JSON.stringify({type:'done'})+'\n',()=>process.exit(0))})})();";
        if (scenario == "four-inflight" || scenario == "five-inflight") return "const count=" + (scenario == "four-inflight" ? "4" : "5") + ";const pending=new Set(Array.from({length:count},(_,i)=>i+1));for(let id=1;id<=count;id++)process.stdout.write(JSON.stringify({type:'request',id,op:'adapter',payload:{text:'item-'+id}})+'\\n');let b='',finished=false;process.stdin.on('data',d=>{b+=d.toString();let n;while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(r.type!=='response'||!pending.delete(r.id))process.exit(4)}if(pending.size===0&&!finished){finished=true;process.stdout.write(JSON.stringify({type:'done'})+'\\n',()=>process.exit(0))}});";
        if (scenario == "long-session") return "const count=84,text='x'.repeat(200000),pending=new Set();let id=0,b='';function batch(){while(id<count&&pending.size<4){const nextId=++id;pending.add(nextId);process.stdout.write(JSON.stringify({type:'request',id:nextId,op:'adapter',payload:{text}})+'\\n')}if(id===count&&pending.size===0)process.stdout.write(JSON.stringify({type:'done'})+'\\n',()=>process.exit(0))}process.stdin.on('data',d=>{b+=d.toString();let n;while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(r.type!=='response'||!pending.delete(r.id))process.exit(4);if(pending.size===0)batch()}});batch();";
        if (scenario == "hang") return "setTimeout(()=>{},30000);";
        if (scenario == "flood") return "for(let i=0;i<100000;i++)process.stdout.write(JSON.stringify({type:'request',id:i+1,op:'adapter',payload:{text:'x'}})+'\\n');setTimeout(()=>{},30000);";
        return "const fs=require('node:fs');const path=require('node:path');let checks=true;try{if(fs.readFileSync(path.join(process.env.EXCESS_CONTROLLER_STATE,'identity.json'),'utf8')!=='fixture-state')checks=false}catch{checks=false}try{fs.writeFileSync(path.join(process.env.EXCESS_CONTROLLER_STATE,'denied.txt'),'x');checks=false}catch(e){if(e.code!=='EACCES'&&e.code!=='EPERM')checks=false}try{fs.writeFileSync('controller-marker.txt','x')}catch{checks=false}try{fs.readdirSync(path.dirname(process.execPath));checks=false}catch(e){if(e.code!=='EACCES'&&e.code!=='EPERM')checks=false}try{fs.readFileSync(process.env.EXCESS_CONTROLLER_SIBLING);checks=false}catch(e){if(e.code!=='EACCES'&&e.code!=='EPERM')checks=false}process.stdout.write(JSON.stringify({type:'request',id:1,op:'adapter',payload:{text:'ping',checks}})+'\\n');let b='';process.stdin.on('data',d=>{b+=d.toString();if(!b.includes('\\n'))return;const r=JSON.parse(b.slice(0,b.indexOf('\\n')));if(r.type!=='response'||r.id!==1||r.ok!==true||r.payload!=='pong'||!checks)process.exit(3);process.stdout.write(JSON.stringify({type:'done'})+'\\n',()=>process.exit(0))});";
    }

    private static bool ValidRequest(Dictionary<string, object> frame, long lastId)
    {
        if (String.Join(",", SortedKeys(frame)) != "id,op,payload,type" || Text(frame, "type") != "request") return false;
        long id = Integer(frame, "id"); string op = Text(frame, "op");
        if (id <= lastId || id > 9007199254740991L || (op != "coordinator" && op != "state" && op != "adapter") || !(frame["payload"] is Dictionary<string, object>)) return false;
        return true;
    }

    private static bool ValidResponse(Dictionary<string, object> frame, long id)
    {
        if (Text(frame, "type") != "response" || Integer(frame, "id") != id) return false;
        bool ok = Flag(frame, "ok");
        if (ok) return String.Join(",", SortedKeys(frame)) == "id,ok,payload,type" && Encoding.UTF8.GetByteCount(Json.Serialize(frame)) <= FrameLimit;
        return String.Join(",", SortedKeys(frame)) == "code,id,ok,type" && IsSafeCode(Text(frame, "code")) && Encoding.UTF8.GetByteCount(Json.Serialize(frame)) <= FrameLimit;
    }

    private sealed class PendingOperation
    {
        public readonly long RequestBytes; public readonly Stopwatch Clock = Stopwatch.StartNew();
        public PendingOperation(long bytes) { RequestBytes = bytes; }
    }
    private sealed class QueuedFrame
    {
        public readonly Dictionary<string, object> Value; public readonly long Bytes;
        public QueuedFrame(Dictionary<string, object> value, long bytes) { Value = value; Bytes = bytes; }
    }
    private sealed class ReplyFrame
    {
        public readonly long Id, Bytes; public readonly string Line;
        public ReplyFrame(long id, string line, long bytes) { Id = id; Line = line; Bytes = bytes; }
    }

    private static string BuildEnvironment(string scratch, string package, string origin, string state, bool fixture)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows), drive = Path.GetPathRoot(scratch).TrimEnd('\\');
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        env["=" + drive] = scratch; env["APPDATA"] = scratch; env["LOCALAPPDATA"] = scratch; env["USERPROFILE"] = scratch;
        env["PATH"] = Path.Combine(package, "node"); env["SystemRoot"] = windows; env["WINDIR"] = windows; env["TEMP"] = scratch; env["TMP"] = scratch;
        if (fixture) { env["EXCESS_CONTROLLER_ORIGIN"] = origin; env["EXCESS_CONTROLLER_STATE"] = state; env["EXCESS_CONTROLLER_PACKAGE"] = package; if (TestSibling != null) env["EXCESS_CONTROLLER_SIBLING"] = TestSibling; }
        var result = new StringBuilder(); foreach (var pair in env) result.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); return result.Append('\0').ToString();
    }

    private static void CreatePipe(out IntPtr read, out IntPtr write)
    { var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true }; if (!CreatePipeNative(out read, out write, ref sa, 0)) throw new ProtocolException("PIPE_SETUP_FAILED"); }
    private static void SetJobLimits(IntPtr job, ulong memory, uint processes)
    {
        var value = new JobExtendedLimitInformation(); value.Basic.Flags = JobKillOnClose | JobProcessMemory | JobMemory | JobActiveProcess;
        value.Basic.ActiveProcessLimit = processes; value.ProcessMemory = new UIntPtr(memory); value.JobMemory = new UIntPtr(memory);
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobExtendedLimitInformation)));
        try { Marshal.StructureToPtr(value, buffer, false); if (!SetInformationJobObject(job, JobExtendedLimit, buffer, (uint)Marshal.SizeOf(typeof(JobExtendedLimitInformation)))) throw new ProtocolException("JOB_LIMITS_FAILED"); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void ValidateOwnedDirectory(string path, bool allowContent)
    {
        var info = new DirectoryInfo(path); if (!info.Exists) throw new ProtocolException("DIRECTORY_REQUIRED");
        RejectReparse(path); var owner = info.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner == null || !owner.Equals(WindowsIdentity.GetCurrent().User)) throw new ProtocolException("DIRECTORY_OWNER_INVALID");
        if (!allowContent && info.GetFileSystemInfos().Length != 0) throw new ProtocolException("DIRECTORY_NOT_EMPTY");
    }

    private static void HoldExactFile(string path, List<FileStream> held)
    {
        RejectReparse(path); var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var owner = File.GetAccessControl(path, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner == null || !owner.Equals(WindowsIdentity.GetCurrent().User)) { stream.Dispose(); throw new ProtocolException("STATE_FILE_OWNER_INVALID"); }
        if (stream.Length < 1 || stream.Length > 65536) { stream.Dispose(); throw new ProtocolException("STATE_FILE_INVALID"); }
        held.Add(stream);
    }

    private static void RejectReparse(string path)
    {
        string current = Path.GetFullPath(path);
        while (!String.IsNullOrEmpty(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ProtocolException("PATH_REPARSE_INVALID");
            string parent = Path.GetDirectoryName(current); if (String.IsNullOrEmpty(parent) || parent == current) break; current = parent;
        }
    }

    private static bool RemoveScratch(string path)
    {
        if (String.IsNullOrEmpty(path) || !Directory.Exists(path)) return true;
        try
        {
            foreach (string name in new[] { "controller-marker.txt", "scratch-marker.txt" }) { string file = Path.Combine(path, name); if (File.Exists(file)) File.Delete(file); }
            if (Directory.GetFileSystemEntries(path).Length != 0) return false; Directory.Delete(path, false); return true;
        }
        catch { return false; }
    }

    private static void TryOutput(string line)
    {
        if (OutputBroken) return;
        if (!Output.TryAdd(line, 0)) RequestStop("output-backpressure");
    }
    private static void FixturePhase(string phase)
    {
        // Optional fixture telemetry must not terminate the controller or take
        // the last slot needed by its readiness frame. Protocol frames still
        // use the fail-closed output boundary.
        if (!OutputBroken && Output.Count < 3)
            Output.TryAdd("{\"type\":\"phase\",\"phase\":\"" + phase + "\"}", 0);
    }
    private static void StartOutput()
    {
        var thread = new Thread(() =>
        {
            try { foreach (string line in Output.GetConsumingEnumerable()) { Console.Out.WriteLine(line); Console.Out.Flush(); if (line.StartsWith("{\"type\":\"ready\",", StringComparison.Ordinal)) ReadyOutputDone.Set(); } }
            catch { OutputBroken = true; RequestStop("output-unavailable"); }
            finally { OutputDone.Set(); }
        }); thread.IsBackground = true; thread.Name = "controller-parent-output"; thread.Start();
    }
    private static void FinalError(string code) { TryOutput("{\"type\":\"error\",\"code\":\"" + SafeCode(code) + "\"}"); }
    private static void FinalErrorIfNeeded() { if (ErrorCode != "none") FinalError(ErrorCode); }
    private static void FinishOutput() { try { Output.CompleteAdding(); } catch { } OutputDone.WaitOne(2000); }
    private static void DiscardOutput() { string ignored; while (Output.TryTake(out ignored)) { } }

    private static bool TerminateJobAndWait(IntPtr job, IntPtr process, uint exit)
    {
        if (process == IntPtr.Zero || WaitForSingleObject(process, 0) == WaitObject) return true;
        if (job != IntPtr.Zero) TerminateJobObject(job, exit); else TerminateProcess(process, exit);
        return WaitForSingleObject(process, 5000) == WaitObject;
    }
    private static bool TerminateAndWaitProcess(IntPtr process, uint exit)
    { if (process == IntPtr.Zero || WaitForSingleObject(process, 0) == WaitObject) return true; TerminateProcess(process, exit); return WaitForSingleObject(process, 5000) == WaitObject; }

    private sealed class BoundedLineReader
    {
        private readonly TextReader Reader; private readonly char[] Buffer = new char[8192]; private int Position, Count;
        public BoundedLineReader(TextReader reader) { Reader = reader; }
        public bool ReadLine(int max, out string line)
        {
            var b = new StringBuilder();
            while (true)
            {
                if (Position >= Count) { Count = Reader.Read(Buffer, 0, Buffer.Length); Position = 0; if (Count == 0) { line = null; return false; } }
                char ch = Buffer[Position++]; if (ch == '\n') break; if (ch == '\r') continue;
                if (b.Length >= max) throw new ProtocolException("FRAME_TOO_LARGE"); b.Append(ch);
            }
            if (b.Length == 0) throw new ProtocolException("FRAME_EMPTY"); line = b.ToString(); return true;
        }
    }
    private static Dictionary<string, object> Parse(string line)
    { try { var value = Json.Deserialize<Dictionary<string, object>>(line); if (value == null || Encoding.UTF8.GetByteCount(line) > FrameLimit) throw new Exception(); return value; } catch { throw new ProtocolException("FRAME_INVALID"); } }
    private static string[] SortedKeys(Dictionary<string, object> frame) { var keys = new List<string>(frame.Keys); keys.Sort(StringComparer.Ordinal); return keys.ToArray(); }
    private static string Text(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as string : null; }
    private static bool Flag(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is bool && (bool)v; }
    private static long Integer(Dictionary<string, object> d, string k) { object v; if (!d.TryGetValue(k, out v)) return -1; try { return Convert.ToInt64(v); } catch { return -1; } }
    private static string Full(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 32768 || value.StartsWith("\\\\", StringComparison.Ordinal) || value.StartsWith("//", StringComparison.Ordinal)) throw new ProtocolException("PATH_INVALID");
        string full = Path.GetFullPath(value);
        if (full.Length <= 3 || full.StartsWith("\\\\?\\", StringComparison.Ordinal) || full.StartsWith("\\\\.\\", StringComparison.Ordinal)) throw new ProtocolException("PATH_INVALID");
        return full;
    }
    private static bool IsWithin(string first, string second)
    {
        string root = Path.GetFullPath(first).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string target = Path.GetFullPath(second).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return target.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }
    private static void RequireHash(string hash) { if (String.IsNullOrEmpty(hash) || hash.Length != 64) throw new ProtocolException("PIN_INVALID"); foreach (char c in hash) if (!Uri.IsHexDigit(c) || Char.IsUpper(c)) throw new ProtocolException("PIN_INVALID"); }
    private static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) { var result = sha.ComputeHash(bytes); var s = new StringBuilder(); foreach (byte b in result) s.Append(b.ToString("x2")); return s.ToString(); } }
    private static string Hash(Stream stream) { using (var sha = SHA256.Create()) { var result = sha.ComputeHash(stream); var s = new StringBuilder(); foreach (byte b in result) s.Append(b.ToString("x2")); return s.ToString(); } }
    private static bool IsSafeCode(string code)
    {
        if (String.IsNullOrEmpty(code) || code.Length > 64) return false;
        foreach (char c in code) if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-' && c != '_') return false;
        return true;
    }
    private static string SafeCode(string value) { if (String.IsNullOrEmpty(value)) return "FAILED"; var b = new StringBuilder(); foreach (char c in value) if (Char.IsLetterOrDigit(c) || c == '-' || c == '_') b.Append(c); return b.Length == 0 ? "FAILED" : b.ToString(); }
    private static string Quote(string value)
    { var b = new StringBuilder("\""); int n = 0; foreach (char c in value) { if (c == '\\') { n++; continue; } if (c == '"') { b.Append('\\', n * 2 + 1).Append('"'); n = 0; continue; } b.Append('\\', n).Append(c); n = 0; } return b.Append('\\', n * 2).Append('"').ToString(); }
    private static void Close(IntPtr h) { if (h != IntPtr.Zero && h != new IntPtr(-1)) CloseHandle(h); }

    // Serialize only ACL edits, not workloads. Never restore another live
    // sandbox's temporary grants from a stale whole-descriptor snapshot.
    private sealed class AclEditLock : IDisposable
    {
        private Mutex mutex;
        private bool held;
        public AclEditLock()
        {
            var owner = WindowsIdentity.GetCurrent().User;
            var security = new MutexSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new MutexAccessRule(owner, MutexRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), MutexRights.FullControl, AccessControlType.Allow));
            bool created;
            mutex = new Mutex(false, "Local\\Excess.AclEdit.v1." + owner.Value, out created, security);
            try { try { held = mutex.WaitOne(5000); } catch (AbandonedMutexException) { held = true; } }
            catch { mutex.Dispose(); mutex = null; throw; }
            if (!held) { mutex.Dispose(); mutex = null; throw new InvalidOperationException("acl-edit-timeout"); }
        }
        public void Dispose()
        {
            if (mutex == null) return;
            try { if (held) mutex.ReleaseMutex(); } finally { held = false; mutex.Dispose(); mutex = null; }
        }
    }

    private sealed class AclLease
    {
        private readonly List<Action> restoreActions = new List<Action>();
        private readonly HashSet<string> savedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private static FileSystemAccessRule[] OwnRules(FileSystemSecurity security, SecurityIdentifier sid)
        {
            var result = new List<FileSystemAccessRule>();
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                if (rule.IdentityReference.Equals(sid)) result.Add(rule);
            return result.ToArray();
        }
        public void GrantDirectory(string path, SecurityIdentifier sid, FileSystemRights rights, bool inheritance)
        {
            using (new AclEditLock())
            {
                var info = new DirectoryInfo(path);
                var originalRules = OwnRules(info.GetAccessControl(AccessControlSections.Access), sid);
                Save(path, delegate
                {
                    using (new AclEditLock())
                    {
                        var current = info.GetAccessControl(AccessControlSections.Access);
                        current.PurgeAccessRules(sid);
                        foreach (var rule in originalRules) current.AddAccessRule(rule);
                        info.SetAccessControl(current);
                    }
                });
                var security = info.GetAccessControl(AccessControlSections.Access);
                var flags = inheritance ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
                security.AddAccessRule(new FileSystemAccessRule(sid, rights, flags, PropagationFlags.None, AccessControlType.Allow));
                info.SetAccessControl(security);
            }
        }
        public void GrantFile(string path, SecurityIdentifier sid, FileSystemRights rights)
        {
            using (new AclEditLock())
            {
                var info = new FileInfo(path);
                var originalRules = OwnRules(info.GetAccessControl(AccessControlSections.Access), sid);
                Save(path, delegate
                {
                    using (new AclEditLock())
                    {
                        var current = info.GetAccessControl(AccessControlSections.Access);
                        current.PurgeAccessRules(sid);
                        foreach (var rule in originalRules) current.AddAccessRule(rule);
                        info.SetAccessControl(current);
                    }
                });
                var security = info.GetAccessControl(AccessControlSections.Access);
                security.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
                info.SetAccessControl(security);
            }
        }
        private void Save(string path, Action restore)
        {
            if (savedPaths.Add(Path.GetFullPath(path))) restoreActions.Add(restore);
        }
        public bool Restore()
        {
            bool okay = true;
            for (int i = restoreActions.Count - 1; i >= 0; i--)
                try { restoreActions[i](); } catch { okay = false; }
            return okay;
        }
    }

    private sealed class ProtocolException : Exception { public string Code; public ProtocolException(string code) { Code = code; } }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityCapabilities { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfo { public int cb; public string Reserved; public string Desktop; public string Title; public uint X; public uint Y; public uint XSize; public uint YSize; public uint XCountChars; public uint YCountChars; public uint FillAttribute; public uint Flags; public short ShowWindow; public short Reserved2; public IntPtr Reserved2Ptr; public IntPtr StdInput; public IntPtr StdOutput; public IntPtr StdError; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process; public IntPtr Thread; public uint ProcessId; public uint ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps; public ulong WriteOps; public ulong OtherOps; public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct JobBasicLimitInformation { public long ProcessUserTime; public long JobUserTime; public uint Flags; public UIntPtr MinWorkingSet; public UIntPtr MaxWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority; public uint Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct JobExtendedLimitInformation { public JobBasicLimitInformation Basic; public IoCounters Io; public UIntPtr ProcessMemory; public UIntPtr JobMemory; public UIntPtr PeakProcessMemory; public UIntPtr PeakJobMemory; }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, uint info, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true, EntryPoint="CreatePipe")] private static extern bool CreatePipeNative(out IntPtr read, out IntPtr write, ref SecurityAttributes sa, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes sa, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] private static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] private static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] private static extern bool FreeSid(IntPtr sid);
}
