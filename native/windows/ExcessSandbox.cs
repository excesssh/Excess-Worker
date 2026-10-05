using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ExcessSandbox
{
    private static string currentStage = "config";
    private static string stopReasonCode = "none";
    private static readonly ManualResetEvent stopEvent = new ManualResetEvent(false);
    private static readonly BlockingCollection<string> controlLines = new BlockingCollection<string>(new ConcurrentQueue<string>(), 2);
    private static readonly ManualResetEvent configReady = new ManualResetEvent(false);
    private static readonly ManualResetEvent configModeReady = new ManualResetEvent(false);
    private static BlockingCollection<string> statusOutput;
    private static readonly ManualResetEvent statusOutputDone = new ManualResetEvent(false);
    private static volatile bool statusOutputFailed;
    private static volatile bool cleanupUnsafe;
    private static Stopwatch setupClock;
    private static bool relayControlMode;
    private static string configLine;
    private static bool configReadFailed;
    private const int MaximumSetupMilliseconds = 180000;
    private const uint ReapTimeoutMilliseconds = 5000;
    private const uint CreateSuspended = 0x00000004;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const int ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobLimitActiveProcess = 0x00000008;
    private const uint JobLimitProcessMemory = 0x00000100;
    private const uint JobLimitJobMemory = 0x00000200;
    private const uint JobLimitKillOnClose = 0x00002000;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x80;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x00000102;
    private const uint Infinite = 0xffffffff;

    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--probe-connect")
            return ProbeConnect(args);
        if (args.Length > 0 && args[0] == "--probe-idle")
            return 57;
        if (args.Length > 0 && args[0] == "--probe-hang")
        {
            System.Threading.Thread.Sleep(-1);
            return 58;
        }
        if (args.Length > 0 && args[0] == "--probe-listen")
            return ProbeListen(args);
        if (args.Length > 0 && args[0] == "--probe-intra-loopback")
            return ProbeIntraLoopback(args);
        if (args.Length > 0 && args[0] == "--probe-http-server")
            return ProbeHttpServer(args);
        if (args.Length > 0 && args[0] == "--relay")
            return RunRelay(args);

        StartStatusOutput();
        int result;
        try { result = RunSandbox(args); }
        finally { CompleteStatusOutput(); }
        return result;
    }

    private static int RunSandbox(string[] args)
    {
        var pinnedFiles = new List<FileStream>();
        Mutex aclTransaction = null;
        bool aclTransactionHeld = false;
        try
        {
            StartControlInput();
            WriteDiagnosticPhase("config-read-start");
            if (!configReady.WaitOne(30000) || configReadFailed || configLine == null)
                return Fail("invalid-config", 2);

            var serializer = new JavaScriptSerializer { MaxJsonLength = 65536 };
            var config = serializer.Deserialize<Dictionary<string, object>>(configLine);
            if (config == null)
            {
                configModeReady.Set();
                return Fail("invalid-config", 2);
            }
            setupClock = Stopwatch.StartNew();
            relayControlMode = config.ContainsKey("relayFile");
            configModeReady.Set();
            WriteDiagnosticPhase("config-read-done");

            currentStage = "config-executable";
            string executable = RequiredString(config, "executable");
            currentStage = "config-runtime";
            string runtimeRoot = RequiredString(config, "runtimeRoot");
            currentStage = "config-scratch";
            string scratchRoot = RequiredString(config, "scratchDirectory");
            currentStage = "config-runtime-files";
            RuntimeFile[] runtimeFiles = RequiredRuntimeFiles(config, "runtimeFiles");
            currentStage = "config-models";
            RuntimeFile[] modelFiles = RequiredRuntimeFiles(config, "modelFiles");
            RuntimeFile relayFile = null;
            int runtimePort = 0;
            if (config.ContainsKey("relayFile"))
            {
                currentStage = "config-relay";
                var relay = config["relayFile"] as Dictionary<string, object>;
                if (relay == null) return Fail("invalid-relay-file", 2);
                relayFile = new RuntimeFile { Path = RequiredString(relay, "path"), Sha256 = RequiredString(relay, "sha256") };
                runtimePort = checked((int)RequiredUInt64(config, "runtimePort"));
                if (runtimePort < 1 || runtimePort > 65535) return Fail("invalid-runtime-port", 2);
            }
            currentStage = "config-arguments";
            string[] childArguments = OptionalStringArray(config, "arguments");
            currentStage = "config-memory";
            ulong memoryLimitBytes = RequiredUInt64(config, "memoryLimitBytes");
            currentStage = "config-process-limit";
            uint processLimit = checked((uint)RequiredUInt64(config, "processLimit"));
            uint timeoutMilliseconds = checked((uint)RequiredUInt64(config, "timeoutMilliseconds"));
            if (memoryLimitBytes < 16UL * 1024 * 1024 || processLimit < 1 || processLimit > 256 ||
                timeoutMilliseconds < 100 || timeoutMilliseconds > 600000)
                return Fail("invalid-limits", 2);

            currentStage = "path-validation";
            executable = Path.GetFullPath(executable);
            runtimeRoot = Path.GetFullPath(runtimeRoot);
            scratchRoot = Path.GetFullPath(scratchRoot);
            if (!Directory.Exists(runtimeRoot) || !Directory.Exists(scratchRoot) || !File.Exists(executable))
                return Fail("invalid-path-state", 2);
            if (!IsWithin(runtimeRoot, executable))
                return Fail("executable-outside-runtime", 2);
            RejectReparsePath(runtimeRoot);
            RejectReparsePath(scratchRoot);
            RejectReparsePath(executable);

            bool executablePinned = false;
            WriteDiagnosticPhase("runtime-hash-start");
            foreach (RuntimeFile runtimeFile in runtimeFiles)
            {
                CheckSetup();
                runtimeFile.Path = Path.GetFullPath(runtimeFile.Path);
                if (!File.Exists(runtimeFile.Path) || !IsWithin(runtimeRoot, runtimeFile.Path))
                    return Fail("invalid-runtime-file", 2);
                RejectPinnedFilePath(runtimeFile.Path);
                RejectReparsePath(runtimeFile.Path);
                FileStream pinnedRuntime = OpenPinnedFile(runtimeFile.Path);
                pinnedFiles.Add(pinnedRuntime);
                if (!HashMatches(pinnedRuntime, runtimeFile.Sha256))
                    return Fail("runtime-hash-mismatch", 2);
                if (String.Equals(runtimeFile.Path, executable, StringComparison.OrdinalIgnoreCase)) executablePinned = true;
            }
            if (!executablePinned) return Fail("executable-not-pinned", 2);
            WriteDiagnosticPhase("runtime-hash-done");

            bool relayPinned = false;
            if (relayFile != null)
            {
                CheckSetup();
                relayFile.Path = Path.GetFullPath(relayFile.Path);
                if (!File.Exists(relayFile.Path)) return Fail("relay-file-missing", 2);
                RejectPinnedFilePath(relayFile.Path);
                RejectUserTreeRelayPath(relayFile.Path);
                RejectReparsePath(relayFile.Path);
                FileStream pinnedRelay = OpenPinnedFile(relayFile.Path);
                pinnedFiles.Add(pinnedRelay);
                if (!HashMatches(pinnedRelay, relayFile.Sha256)) return Fail("relay-hash-mismatch", 2);
                string ownImage = Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location);
                if (!String.Equals(relayFile.Path, ownImage, StringComparison.OrdinalIgnoreCase))
                    return Fail("relay-image-mismatch", 2);
                relayPinned = true;
            }

            WriteDiagnosticPhase("model-hash-start");
            foreach (RuntimeFile model in modelFiles)
            {
                CheckSetup();
                model.Path = Path.GetFullPath(model.Path);
                if (!File.Exists(model.Path))
                    return Fail("model-file-missing", 2);
                RejectPinnedFilePath(model.Path);
                RejectReparsePath(model.Path);
                FileStream pinnedModel = OpenPinnedFile(model.Path);
                pinnedFiles.Add(pinnedModel);
                if (!HashMatches(pinnedModel, model.Sha256)) return Fail("model-hash-mismatch", 2);
            }
            WriteDiagnosticPhase("model-hash-done");
            RejectPinnedDirectoryPath(runtimeRoot);
            ValidatePrivateScratchRoot(scratchRoot);
            CheckSetup();

            currentStage = "acl-transaction-lock";
            aclTransaction = new Mutex(false, "Local\\Excess.Worker.Runtime.AclLease.v1");
            var lockWait = Stopwatch.StartNew();
            while (!aclTransactionHeld && lockWait.ElapsedMilliseconds < 30000)
            {
                CheckSetup();
                try { aclTransactionHeld = aclTransaction.WaitOne(250); }
                catch (AbandonedMutexException) { aclTransactionHeld = true; }
            }
            if (!aclTransactionHeld) return Fail("acl-transaction-busy", 1);
            CheckSetup();
            WriteDiagnosticPhase("acl-transaction-acquired");

            currentStage = "profile";
            WriteDiagnosticPhase("profile-create-start");
            string appContainerName = "Excess.Worker.Runtime." + Guid.NewGuid().ToString("N");
            IntPtr appContainerSid = CreateAppContainer(appContainerName);
            WriteDiagnosticPhase("profile-create-done");
            string scratch = Path.Combine(scratchRoot, "session-" + Guid.NewGuid().ToString("N"));
            SecurityIdentifier packageSid = null;
            AclLease aclLease = null;
            int childResult = 1;
            string setupFailure = null;
            bool aclRestored = false;
            bool profileDeleted = false;
            bool scratchDeleted = false;
            try
            {
                packageSid = new SecurityIdentifier(appContainerSid);
                aclLease = new AclLease(packageSid);
                CheckSetup();
                Directory.CreateDirectory(scratch);
                RejectReparsePath(scratch);
                currentStage = "runtime-acl";
                CheckSetup();
                RequireCurrentUserOwnedDirectory(runtimeRoot);
                aclLease.GrantDirectory(packageSid, runtimeRoot, FileSystemRights.ReadAndExecute, false);
                foreach (RuntimeFile runtimeFile in runtimeFiles)
                {
                    CheckSetup();
                    aclLease.GrantFile(packageSid, runtimeFile.Path, FileSystemRights.ReadAndExecute);
                }
                WriteDiagnosticPhase("runtime-acl-done");
                currentStage = "model-acl";
                foreach (RuntimeFile model in modelFiles)
                {
                    CheckSetup();
                    aclLease.GrantFile(packageSid, model.Path, FileSystemRights.Read);
                }
                WriteDiagnosticPhase("model-acl-done");
                if (relayPinned)
                {
                    currentStage = "relay-acl";
                    CheckSetup();
                    aclLease.GrantFile(packageSid, relayFile.Path, FileSystemRights.ReadAndExecute);
                }
                WriteDiagnosticPhase("relay-acl-done");
                currentStage = "scratch-acl";
                CheckSetup();
                aclLease.GrantDirectory(packageSid, scratch, FileSystemRights.Modify, true);
                WriteDiagnosticPhase("scratch-acl-done");

                currentStage = "launch";
                CheckSetup();
                WriteDiagnosticPhase("child-launch-start");
                if (relayPinned)
                {
                    if (processLimit != 2) return Fail("invalid-relay-process-limit", 2);
                    childResult = RunRelayInContainer(packageSid, appContainerSid, executable, relayFile.Path,
                        runtimeRoot, scratch, childArguments, runtimePort, memoryLimitBytes, timeoutMilliseconds, stopEvent);
                }
                else
                {
                    childResult = RunInContainer(packageSid, appContainerSid, executable, runtimeRoot, scratch,
                        childArguments, memoryLimitBytes, processLimit, timeoutMilliseconds, stopEvent);
                }
            }
            catch (OperationCanceledException)
            {
                setupFailure = "setup-cancelled";
                stopReasonCode = "setup-cancelled";
            }
            catch (TimeoutException)
            {
                setupFailure = "setup-timeout";
                stopReasonCode = "setup-timeout";
            }
            finally
            {
                currentStage = "cleanup";
                ReleasePinnedFiles(pinnedFiles);
                if (cleanupUnsafe)
                {
                    aclRestored = false;
                    scratchDeleted = false;
                    profileDeleted = false;
                }
                else
                {
                    aclRestored = aclLease == null || aclLease.Restore();
                    scratchDeleted = DeletePrivateScratch(scratchRoot, scratch);
                    profileDeleted = DeleteAppContainerProfile(appContainerName);
                }
                FreeSid(appContainerSid);
            }
            if (!aclRestored) { WriteCleanup(false, "acl-cleanup-failed"); return Fail("acl-cleanup-failed", 1); }
            if (!scratchDeleted) { WriteCleanup(false, "scratch-cleanup-failed"); return Fail("scratch-cleanup-failed", 1); }
            if (!profileDeleted) { WriteCleanup(false, "profile-cleanup-failed"); return Fail("profile-cleanup-failed", 1); }
            WriteCleanup(true, null);
            if (setupFailure != null) return Fail(setupFailure, 1);
            return childResult;
        }
        catch (Win32Exception ex)
        {
            return Fail("win32-" + currentStage, ex.NativeErrorCode);
        }
        catch (OperationCanceledException)
        {
            WriteCleanup(true, null);
            return Fail(stopEvent.WaitOne(0) ? "setup-cancelled" : "setup-timeout", 1);
        }
        catch (TimeoutException)
        {
            stopReasonCode = "setup-timeout";
            WriteCleanup(true, null);
            return Fail("setup-timeout", 1);
        }
        catch (Exception ex)
        {
            return Fail("sandbox-error-" + currentStage + "-" + ex.GetType().Name + "-" +
                (ex.TargetSite == null ? "unknown" : ex.TargetSite.Name), ex.HResult);
        }
        finally
        {
            if (aclTransactionHeld) { try { aclTransaction.ReleaseMutex(); } catch { } }
            if (aclTransaction != null) aclTransaction.Dispose();
            ReleasePinnedFiles(pinnedFiles);
        }
    }

    private static void ReleasePinnedFiles(List<FileStream> files)
    {
        foreach (FileStream file in files)
        {
            try { file.Dispose(); }
            catch { }
        }
        files.Clear();
    }

    private static int RunRelayInContainer(SecurityIdentifier packageSid, IntPtr packageSidPtr,
        string executable, string relayExecutable, string runtimeRoot, string scratch, string[] arguments,
        int runtimePort, ulong memoryLimitBytes, uint timeoutMilliseconds, ManualResetEvent requestedStop)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError();
        IntPtr runtimeProcess = IntPtr.Zero, runtimeThread = IntPtr.Zero, relayProcess = IntPtr.Zero, relayThread = IntPtr.Zero;
        IntPtr runtimeIn = IntPtr.Zero, runtimeOut = IntPtr.Zero, runtimeErrRead = IntPtr.Zero, runtimeErrWrite = IntPtr.Zero;
        IntPtr relayIn = IntPtr.Zero, parentRelayIn = IntPtr.Zero;
        IntPtr parentRelayOut = IntPtr.Zero, relayOut = IntPtr.Zero, relayErr = IntPtr.Zero;
        bool runtimeAssigned = false, relayAssigned = false;
        try
        {
            var limits = new JobExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobLimitKillOnClose | JobLimitProcessMemory | JobLimitJobMemory | JobLimitActiveProcess;
            limits.BasicLimitInformation.ActiveProcessLimit = 2;
            limits.ProcessMemoryLimit = new UIntPtr(memoryLimitBytes);
            limits.JobMemoryLimit = new UIntPtr(memoryLimitBytes);
            int limitSize = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
            IntPtr limitBuffer = Marshal.AllocHGlobal(limitSize);
            try
            {
                Marshal.StructureToPtr(limits, limitBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitBuffer, (uint)limitSize)) throw LastError();
            }
            finally { Marshal.FreeHGlobal(limitBuffer); }

            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
            runtimeIn = CreateFile("NUL", GenericRead, FileShareRead | FileShareWrite, ref security, OpenExisting, FileAttributeNormal, IntPtr.Zero);
            runtimeOut = CreateFile("NUL", GenericWrite, FileShareRead | FileShareWrite, ref security, OpenExisting, FileAttributeNormal, IntPtr.Zero);
            relayErr = CreateFile("NUL", GenericWrite, FileShareRead | FileShareWrite, ref security, OpenExisting, FileAttributeNormal, IntPtr.Zero);
            if (IsInvalidHandle(runtimeIn) || IsInvalidHandle(runtimeOut) || IsInvalidHandle(relayErr)) throw LastError();
            if (!CreatePipe(out runtimeErrRead, out runtimeErrWrite, ref security, 0) ||
                !SetHandleInformation(runtimeErrRead, 1, 0)) throw LastError();
            if (!CreatePipe(out relayIn, out parentRelayIn, ref security, 0) ||
                !CreatePipe(out parentRelayOut, out relayOut, ref security, 0)) throw LastError();
            if (!SetHandleInformation(parentRelayIn, 1, 0) || !SetHandleInformation(parentRelayOut, 1, 0)) throw LastError();

            string environment = BuildChildEnvironment(runtimeRoot, scratch, true);
            currentStage = "runtime-create-suspended";
            var runtimeHandles = new[] { runtimeIn, runtimeOut, runtimeErrWrite };
            ProcessInformation runtimeInfo = CreateAppContainerChild(executable, arguments, packageSidPtr, environment,
                scratch, runtimeHandles, runtimeIn, runtimeOut, runtimeErrWrite);
            runtimeProcess = runtimeInfo.hProcess; runtimeThread = runtimeInfo.hThread;

            currentStage = "relay-create-suspended";
            var relayHandles = new[] { relayIn, relayOut, relayErr };
            string[] relayArgs = new[] { "--relay", runtimePort.ToString(CultureInfo.InvariantCulture) };
            ProcessInformation relayInfo = CreateAppContainerChild(relayExecutable, relayArgs, packageSidPtr, environment,
                scratch, relayHandles, relayIn, relayOut, relayErr);
            relayProcess = relayInfo.hProcess; relayThread = relayInfo.hThread;

            currentStage = "runtime-assign-job";
            if (!AssignProcessToJobObject(job, runtimeProcess)) throw LastError();
            runtimeAssigned = true;
            currentStage = "relay-assign-job";
            if (!AssignProcessToJobObject(job, relayProcess)) throw LastError();
            relayAssigned = true;

            CloseHandle(relayIn); relayIn = IntPtr.Zero;
            CloseHandle(relayOut); relayOut = IntPtr.Zero;
            CloseHandle(runtimeIn); runtimeIn = IntPtr.Zero;
            CloseHandle(runtimeOut); runtimeOut = IntPtr.Zero;
            CloseHandle(runtimeErrWrite); runtimeErrWrite = IntPtr.Zero;
            CloseHandle(relayErr); relayErr = IntPtr.Zero;

            currentStage = "runtime-resume";
            if (ResumeThread(runtimeThread) == 0xffffffff) throw LastError();
            currentStage = "relay-resume";
            if (ResumeThread(relayThread) == 0xffffffff) throw LastError();

            WriteStarted(runtimeInfo.dwProcessId);
            var runtimeDiagnostics = new DiagnosticCapture(65536);
            var runtimeErrorReader = new Thread(() => DrainBoundedDiagnostic(runtimeErrRead, runtimeDiagnostics));
            runtimeErrorReader.IsBackground = true; runtimeErrorReader.Name = "sandbox-runtime-diagnostic"; runtimeErrorReader.Start();
            var relayWriter = new StreamWriter(new FileStream(new SafeFileHandle(parentRelayIn, false), FileAccess.Write, 4096), new UTF8Encoding(false));
            var relayReader = new StreamReader(new FileStream(new SafeFileHandle(parentRelayOut, false), FileAccess.Read, 4096), new UTF8Encoding(false));
            int activeRequestId = 0;
            var protocolLock = new object();
            var outputThread = new Thread(() =>
            {
                try
                {
                    string frame;
                    while (ReadBoundedLine(relayReader, 131072, out frame))
                    {
                        if (!ValidateRelayOutput(frame)) { stopReasonCode = "invalid-relay-output"; WriteBridgeError(activeRequestId, "INVALID_RELAY_OUTPUT"); requestedStop.Set(); break; }
                        var parsed = new JavaScriptSerializer { MaxJsonLength = 131072 }.Deserialize<Dictionary<string, object>>(frame);
                        int frameId = Convert.ToInt32(parsed["id"], CultureInfo.InvariantCulture);
                        string frameType = parsed["type"] as string;
                        lock (protocolLock)
                        {
                            if (activeRequestId == 0 || activeRequestId != frameId) { stopReasonCode = "invalid-relay-id"; WriteBridgeError(activeRequestId, "INVALID_RELAY_ID"); requestedStop.Set(); break; }
                            if (frameType == "end" || frameType == "error") activeRequestId = 0;
                        }
                        if (!TryEmitOutput(frame)) break;
                    }
                }
                catch { stopReasonCode = "relay-output-failed"; WriteBridgeError(activeRequestId, "RELAY_OUTPUT_FAILED"); requestedStop.Set(); }
            });
            outputThread.IsBackground = true; outputThread.Name = "sandbox-relay-output"; outputThread.Start();

            var inputThread = new Thread(() =>
            {
                try
                {
                    string frame;
                    while (!requestedStop.WaitOne(0))
                    {
                        if (!TryReadControlLine(out frame, 250))
                        {
                            if (controlLines.IsCompleted || stopEvent.WaitOne(0)) break;
                            continue;
                        }
                        if (frame == "{\"type\":\"stop\"}")
                        {
                            stopReasonCode = "explicit-stop";
                            requestedStop.Set(); return;
                        }
                        if (!ValidateParentFrame(frame)) { stopReasonCode = "invalid-parent-frame"; requestedStop.Set(); WriteBridgeError(1, "INVALID_REQUEST"); return; }
                        var parsed = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }.Deserialize<Dictionary<string, object>>(frame);
                        string frameType = parsed["type"] as string;
                        int frameId = Convert.ToInt32(parsed["id"], CultureInfo.InvariantCulture);
                        lock (protocolLock)
                        {
                            if (frameType == "request")
                            {
                                if (activeRequestId != 0) { stopReasonCode = "request-busy"; requestedStop.Set(); WriteBridgeError(frameId, "REQUEST_BUSY"); return; }
                                activeRequestId = frameId;
                            }
                            else if (activeRequestId != frameId)
                            { stopReasonCode = "invalid-control"; requestedStop.Set(); WriteBridgeError(frameId, "INVALID_CONTROL"); return; }
                        }
                        relayWriter.WriteLine(frame); relayWriter.Flush();
                    }
                }
                catch { stopReasonCode = "input-error"; WriteBridgeError(Math.Max(1, activeRequestId), "CONTROL_FAILED"); }
                if (stopReasonCode == "none") stopReasonCode = "input-eof";
                requestedStop.Set();
            });
            inputThread.IsBackground = true; inputThread.Name = "sandbox-relay-input"; inputThread.Start();

            var supervisionClock = Stopwatch.StartNew();
            uint wait;
            while (true)
            {
                long elapsedMilliseconds = supervisionClock.ElapsedMilliseconds;
                if (elapsedMilliseconds >= timeoutMilliseconds) { wait = WaitTimeout; break; }
                uint waitSlice = (uint)Math.Min(1000L, (long)timeoutMilliseconds - elapsedMilliseconds);
                wait = WaitForMultipleObjects(3, new[] { runtimeProcess, relayProcess, requestedStop.SafeWaitHandle.DangerousGetHandle() }, false, waitSlice);
                if (wait != WaitTimeout) break;
                if (supervisionClock.ElapsedMilliseconds >= timeoutMilliseconds) { wait = WaitTimeout; break; }
                WriteWorkingSetStatus(runtimeInfo.dwProcessId, QueryPeakWorkingSet(runtimeProcess));
            }
            string termination = "exit";
            uint exitCode = 0;
            if (wait == WaitTimeout) { termination = "timeout"; exitCode = 124; }
            else if (wait == WaitObject0 + 2) { termination = "stop"; exitCode = 125; }
            else if (wait == WaitObject0)
            {
                if (!GetExitCodeProcess(runtimeProcess, out exitCode)) throw LastError();
            }
            else if (wait == WaitObject0 + 1) { termination = "relay-exit"; exitCode = 126; }
            else throw LastError();
            if (!TerminateJobAndWait(job, exitCode)) return Fail("job-reap-timeout", 1);
            outputThread.Join(2000);
            runtimeErrorReader.Join(2000);
            ulong peakWorkingSet = QueryPeakWorkingSet(runtimeProcess);
            ulong peakJobCommit = QueryPeakJobCommit(job);
            if (termination == "timeout") exitCode = 124;
            if (termination == "stop") exitCode = 125;
            WriteRunStatus(runtimeInfo.dwProcessId, exitCode, termination, peakWorkingSet, peakJobCommit,
                ClassifyRuntimeDiagnostic(runtimeDiagnostics.ToString(), exitCode));
            return exitCode > 255 ? 1 : (int)exitCode;
        }
        finally
        {
            if (runtimeProcess != IntPtr.Zero && !runtimeAssigned) TerminateAndWaitProcess(runtimeProcess, 126);
            if (relayProcess != IntPtr.Zero && !relayAssigned) TerminateAndWaitProcess(relayProcess, 126);
            if (job != IntPtr.Zero)
            {
                if (!TerminateJobAndWait(job, 126)) cleanupUnsafe = true;
                CloseHandle(job);
            }
            CloseIfValid(runtimeProcess); CloseIfValid(runtimeThread); CloseIfValid(relayProcess); CloseIfValid(relayThread);
            CloseIfValid(runtimeIn); CloseIfValid(runtimeOut); CloseIfValid(runtimeErrRead); CloseIfValid(runtimeErrWrite);
            CloseIfValid(relayIn); CloseIfValid(parentRelayIn);
            CloseIfValid(parentRelayOut); CloseIfValid(relayOut); CloseIfValid(relayErr);
        }
    }

    private static ProcessInformation CreateAppContainerChild(string executable, string[] arguments, IntPtr packageSid,
        string environment, string scratch, IntPtr[] stdHandles, IntPtr stdin, IntPtr stdout, IntPtr stderr)
    {
        IntPtr attrList = IntPtr.Zero, capBuffer = IntPtr.Zero, handleBuffer = IntPtr.Zero, envBuffer = IntPtr.Zero;
        try
        {
            var startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = 0x00000100;
            startup.StartupInfo.hStdInput = stdin; startup.StartupInfo.hStdOutput = stdout; startup.StartupInfo.hStdError = stderr;
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attrList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attrList, 2, 0, ref size)) throw LastError();
            startup.lpAttributeList = attrList;
            var caps = new SecurityCapabilities { AppContainerSid = packageSid, CapabilityCount = 0, Capabilities = IntPtr.Zero, Reserved = 0 };
            int capSize = Marshal.SizeOf(typeof(SecurityCapabilities)); capBuffer = Marshal.AllocHGlobal(capSize); Marshal.StructureToPtr(caps, capBuffer, false);
            if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ProcThreadAttributeSecurityCapabilities), capBuffer, (IntPtr)capSize, IntPtr.Zero, IntPtr.Zero)) throw LastError();
            handleBuffer = Marshal.AllocHGlobal(IntPtr.Size * stdHandles.Length);
            for (int i = 0; i < stdHandles.Length; i++) Marshal.WriteIntPtr(handleBuffer, IntPtr.Size * i, stdHandles[i]);
            if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ProcThreadAttributeHandleList), handleBuffer, (IntPtr)(IntPtr.Size * stdHandles.Length), IntPtr.Zero, IntPtr.Zero)) throw LastError();
            envBuffer = Marshal.StringToHGlobalUni(environment);
            var command = new StringBuilder(Quote(executable)); foreach (string arg in arguments) command.Append(' ').Append(Quote(arg));
            var info = new ProcessInformation();
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | ExtendedStartupInfoPresent | CreateUnicodeEnvironment, envBuffer, scratch, ref startup, out info)) throw LastError();
            return info;
        }
        finally
        {
            if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }
            if (capBuffer != IntPtr.Zero) Marshal.FreeHGlobal(capBuffer);
            if (handleBuffer != IntPtr.Zero) Marshal.FreeHGlobal(handleBuffer);
            if (envBuffer != IntPtr.Zero) Marshal.FreeHGlobal(envBuffer);
        }
    }

    private static string BuildChildEnvironment(string runtimeRoot, string scratch, bool includeApiKey)
    {
        string windowsRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string drive = Path.GetPathRoot(scratch).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        values["=" + drive] = scratch; values["APPDATA"] = scratch; values["LOCALAPPDATA"] = scratch;
        values["PATH"] = runtimeRoot; values["SystemRoot"] = windowsRoot; values["TEMP"] = scratch;
        values["TMP"] = scratch; values["USERPROFILE"] = scratch; values["WINDIR"] = windowsRoot;
        if (includeApiKey)
        {
            string key = Environment.GetEnvironmentVariable("LLAMA_API_KEY");
            if (!String.IsNullOrEmpty(key))
            {
                if (key.Length < 16 || key.Length > 256) throw new ArgumentException("invalid-runtime-api-key");
                foreach (char c in key) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) throw new ArgumentException("invalid-runtime-api-key");
                values["LLAMA_API_KEY"] = key;
            }
            string omp = Environment.GetEnvironmentVariable("OMP_NUM_THREADS"); uint threads;
            if (!String.IsNullOrEmpty(omp)) { if (!UInt32.TryParse(omp, out threads) || threads < 1 || threads > 1024) throw new ArgumentException("invalid-omp-threads"); values["OMP_NUM_THREADS"] = threads.ToString(CultureInfo.InvariantCulture); }
        }
        var block = new StringBuilder(); foreach (var pair in values) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        return block.Append('\0').ToString();
    }

    private static bool IsInvalidHandle(IntPtr handle) { return handle == IntPtr.Zero || handle == new IntPtr(-1); }
    private static void CloseIfValid(IntPtr handle) { if (!IsInvalidHandle(handle)) CloseHandle(handle); }

    private static bool ValidateParentFrame(string line)
    {
        try
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
            var frame = serializer.Deserialize<Dictionary<string, object>>(line);
            if (frame == null || !frame.ContainsKey("type")) return false;
            object typeValue; if (!frame.TryGetValue("type", out typeValue)) return false;
            string type = typeValue as string;
            if (type == "request")
            {
                if (frame.Count < 4 || frame.Count > 5) return false;
                foreach (string key in frame.Keys)
                    if (!(key == "type" || key == "id" || key == "method" || key == "path" || key == "body")) return false;
                string method = frame["method"] as string, path = frame["path"] as string;
                object id; if (!frame.TryGetValue("id", out id) || Convert.ToInt32(id, CultureInfo.InvariantCulture) < 1 || Convert.ToInt32(id, CultureInfo.InvariantCulture) > Int32.MaxValue) return false;
                if (method == "GET") return (path == "/health" || path == "/v1/models") && !frame.ContainsKey("body");
                if (method != "POST" || !(path == "/tokenize" || path == "/completion" || path == "/detokenize" || path == "/v1/embeddings" || path == "/v1/chat/completions" || path == "/v1/images/generations")) return false;
                string body = frame.ContainsKey("body") ? frame["body"] as string : null;
                return body != null && Encoding.UTF8.GetByteCount(body) <= 16 * 1024 * 1024;
            }
            if (type == "next" || type == "cancel") return frame.Count == 2 && frame.ContainsKey("id") && Convert.ToInt32(frame["id"], CultureInfo.InvariantCulture) > 0 && Convert.ToInt32(frame["id"], CultureInfo.InvariantCulture) <= Int32.MaxValue;
        }
        catch { }
        return false;
    }

    private static bool ValidateRelayOutput(string line)
    {
        if (line.Length > 131072) return false;
        try
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 131072 };
            var frame = serializer.Deserialize<Dictionary<string, object>>(line);
            if (frame == null || !frame.ContainsKey("type")) return false;
            string type = frame["type"] as string;
            object id, status;
            if (!frame.TryGetValue("id", out id) || Convert.ToInt32(id, CultureInfo.InvariantCulture) < 1 || Convert.ToInt32(id, CultureInfo.InvariantCulture) > Int32.MaxValue) return false;
            if (type == "response")
            {
                if (frame.Count < 3 || frame.Count > 4 || !frame.TryGetValue("status", out status)) return false;
                int code = Convert.ToInt32(status, CultureInfo.InvariantCulture);
                if (code < 200 || code > 599) return false;
                object headersValue;
                if (frame.TryGetValue("headers", out headersValue))
                {
                    var headers = headersValue as Dictionary<string, object>;
                    if (headers == null || headers.Count > 1) return false;
                    foreach (var pair in headers)
                        if (pair.Key != "content-type" || !(pair.Value is string) || ((string)pair.Value).Length > 256) return false;
                }
                foreach (string key in frame.Keys) if (!(key == "type" || key == "id" || key == "status" || key == "headers")) return false;
                return true;
            }
            if (type == "data")
            {
                object data; if (frame.Count != 3 || !frame.TryGetValue("data", out data) || !(data is string)) return false;
                string encoded = (string)data; if (encoded.Length > 87384 || (encoded.Length % 4) != 0) return false;
                try { return Convert.FromBase64String(encoded).Length <= 65536; } catch { return false; }
            }
            if (type == "end") return frame.Count == 2;
            if (type == "error")
            {
                object error; if (frame.Count != 3 || !frame.TryGetValue("error", out error) || !(error is string)) return false;
                string code = (string)error; if (code.Length < 1 || code.Length > 64) return false;
                foreach (char c in code) if (!((c >= 'A' && c <= 'Z') || c == '_')) return false;
                return true;
            }
        }
        catch { }
        return false;
    }

    private static int RunRelay(string[] args)
    {
        if (args.Length != 2) return 2;
        int port; if (!Int32.TryParse(args[1], out port) || port < 1 || port > 65535) return 2;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
        string input;
        try
        {
            while (ReadBoundedLine(Console.In, 32 * 1024 * 1024, out input))
            {
                if (input == "{\"type\":\"stop\"}") return 0;
                var frame = serializer.Deserialize<Dictionary<string, object>>(input);
                if (frame == null) return 3;
                string type = frame.ContainsKey("type") ? frame["type"] as string : null;
                int id = frame.ContainsKey("id") ? Convert.ToInt32(frame["id"], CultureInfo.InvariantCulture) : 0;
                if (type == "request") { RelayRequest(frame, id, port, serializer); continue; }
                if (type == "next" || type == "cancel") continue; // request loop consumes pull controls.
                return 3;
            }
        }
        catch { return 4; }
        return 0;
    }

    private static void RelayRequest(Dictionary<string, object> request, int id, int port, JavaScriptSerializer serializer)
    {
        string method = request["method"] as string, path = request["path"] as string;
        string body = request.ContainsKey("body") ? request["body"] as string : null;
        if (id < 1 || method == null || path == null || !ValidateRelayRoute(method, path, body)) { WriteRelayError(id, "INVALID_REQUEST", serializer); return; }
        HttpWebRequest web = null; WebResponse response = null; Stream stream = null;
        try
        {
            web = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + path);
            web.Method = method; web.AllowAutoRedirect = false; web.Proxy = null; web.KeepAlive = false; web.Timeout = 30000; web.ReadWriteTimeout = 30000;
            string key = Environment.GetEnvironmentVariable("LLAMA_API_KEY");
            if (!String.IsNullOrEmpty(key)) web.Headers[HttpRequestHeader.Authorization] = "Bearer " + key;
            if (method == "POST")
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body); web.ContentType = "application/json; charset=utf-8"; web.ContentLength = bytes.Length;
                using (Stream output = web.GetRequestStream()) output.Write(bytes, 0, bytes.Length);
            }
            try { response = web.GetResponse(); }
            catch (WebException ex) { response = ex.Response; if (response == null) throw; }
            var headers = new Dictionary<string, string>();
            if (!String.IsNullOrEmpty(response.ContentType)) headers["content-type"] = response.ContentType.Length <= 256 ? response.ContentType : response.ContentType.Substring(0, 256);
            var responseFrame = new Dictionary<string, object>();
            responseFrame["type"] = "response"; responseFrame["id"] = id; responseFrame["status"] = (int)((HttpWebResponse)response).StatusCode; responseFrame["headers"] = headers;
            Console.WriteLine(serializer.Serialize(responseFrame)); Console.Out.Flush();
            stream = response.GetResponseStream(); if (stream == null) { WriteRelayEnd(id, serializer); return; }
            long total = 0; var buffer = new byte[65536];
            while (true)
            {
                string control;
                if (!ReadBoundedLine(Console.In, 1024, out control) || control == "{\"type\":\"stop\"}") { web.Abort(); return; }
                var command = serializer.Deserialize<Dictionary<string, object>>(control);
                if (command == null || !command.ContainsKey("id") || Convert.ToInt32(command["id"], CultureInfo.InvariantCulture) != id) { web.Abort(); WriteRelayError(id, "INVALID_CONTROL", serializer); return; }
                string controlType = command.ContainsKey("type") ? command["type"] as string : null;
                if (controlType == "cancel") { web.Abort(); WriteRelayError(id, "CANCELLED", serializer); return; }
                if (controlType != "next") { web.Abort(); WriteRelayError(id, "INVALID_CONTROL", serializer); return; }
                int count = stream.Read(buffer, 0, buffer.Length);
                if (count == 0) { WriteRelayEnd(id, serializer); return; }
                total += count; if (total > 64L * 1024 * 1024) { web.Abort(); WriteRelayError(id, "RESPONSE_TOO_LARGE", serializer); return; }
                var data = new Dictionary<string, object>(); data["type"] = "data"; data["id"] = id; data["data"] = Convert.ToBase64String(buffer, 0, count);
                Console.WriteLine(serializer.Serialize(data)); Console.Out.Flush();
            }
        }
        catch (WebException) { WriteRelayError(id, "UPSTREAM_UNAVAILABLE", serializer); }
        catch (IOException) { WriteRelayError(id, "UPSTREAM_UNAVAILABLE", serializer); }
        catch { WriteRelayError(id, "RELAY_FAILURE", serializer); }
        finally { if (stream != null) stream.Dispose(); if (response != null) response.Dispose(); if (web != null) web.Abort(); }
    }

    private static bool ValidateRelayRoute(string method, string path, string body)
    {
        if (method == "GET") return body == null && (path == "/health" || path == "/v1/models");
        return method == "POST" && body != null && Encoding.UTF8.GetByteCount(body) <= 16 * 1024 * 1024 &&
            (path == "/tokenize" || path == "/completion" || path == "/detokenize" || path == "/v1/embeddings" || path == "/v1/chat/completions" || path == "/v1/images/generations");
    }
    private static void WriteRelayError(int id, string code, JavaScriptSerializer serializer) { var frame = new Dictionary<string, object>(); frame["type"] = "error"; frame["id"] = Math.Max(1, id); frame["error"] = SafeCode(code).ToUpperInvariant(); Console.WriteLine(serializer.Serialize(frame)); Console.Out.Flush(); }
    private static void WriteRelayEnd(int id, JavaScriptSerializer serializer) { var frame = new Dictionary<string, object>(); frame["type"] = "end"; frame["id"] = id; Console.WriteLine(serializer.Serialize(frame)); Console.Out.Flush(); }
    private static void WriteBridgeError(int id, string code)
    {
        var frame = new Dictionary<string, object>(); frame["type"] = "error"; frame["id"] = Math.Max(1, id); frame["error"] = SafeCode(code).ToUpperInvariant();
        TryEmitOutput(new JavaScriptSerializer().Serialize(frame));
    }

    private static int RunInContainer(SecurityIdentifier packageSid, IntPtr packageSidPtr,
        string executable, string runtimeRoot, string scratch, string[] arguments,
        ulong memoryLimitBytes, uint processLimit, uint timeoutMilliseconds, ManualResetEvent requestedStop)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError();
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        bool processAssigned = false;
        IntPtr attrList = IntPtr.Zero;
        IntPtr attrBuffer = IntPtr.Zero;
        IntPtr handlesBuffer = IntPtr.Zero;
        IntPtr environmentBuffer = IntPtr.Zero;
        IntPtr nullIn = IntPtr.Zero;
        IntPtr nullOut = IntPtr.Zero;
        try
        {
            currentStage = "job-limits";
            var limits = new JobExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobLimitKillOnClose | JobLimitProcessMemory |
                JobLimitJobMemory | JobLimitActiveProcess;
            limits.BasicLimitInformation.ActiveProcessLimit = processLimit;
            limits.ProcessMemoryLimit = new UIntPtr(memoryLimitBytes);
            limits.JobMemoryLimit = new UIntPtr(memoryLimitBytes);
            int limitSize = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
            IntPtr limitBuffer = Marshal.AllocHGlobal(limitSize);
            try
            {
                Marshal.StructureToPtr(limits, limitBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitBuffer, (uint)limitSize))
                    throw LastError();
            }
            finally { Marshal.FreeHGlobal(limitBuffer); }

            currentStage = "stdio";
            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
            nullIn = CreateFile("NUL", GenericRead, FileShareRead | FileShareWrite, ref security,
                OpenExisting, FileAttributeNormal, IntPtr.Zero);
            nullOut = CreateFile("NUL", GenericWrite, FileShareRead | FileShareWrite, ref security,
                OpenExisting, FileAttributeNormal, IntPtr.Zero);
            if (nullIn == IntPtr.Zero || nullOut == IntPtr.Zero || nullIn == new IntPtr(-1) || nullOut == new IntPtr(-1))
                throw LastError();

            currentStage = "attributes";
            var startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = 0x00000100;
            startup.StartupInfo.hStdInput = nullIn;
            startup.StartupInfo.hStdOutput = nullOut;
            startup.StartupInfo.hStdError = nullOut;
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attrList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attrList, 2, 0, ref size)) throw LastError();
            startup.lpAttributeList = attrList;

            var capabilities = new SecurityCapabilities
            {
                AppContainerSid = packageSidPtr,
                CapabilityCount = 0,
                Capabilities = IntPtr.Zero,
                Reserved = 0
            };
            int capSize = Marshal.SizeOf(typeof(SecurityCapabilities));
            attrBuffer = Marshal.AllocHGlobal(capSize);
            Marshal.StructureToPtr(capabilities, attrBuffer, false);
            if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ProcThreadAttributeSecurityCapabilities),
                attrBuffer, (IntPtr)capSize, IntPtr.Zero, IntPtr.Zero)) throw LastError();

            handlesBuffer = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handlesBuffer, 0, nullIn);
            Marshal.WriteIntPtr(handlesBuffer, IntPtr.Size, nullOut);
            if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ProcThreadAttributeHandleList),
                handlesBuffer, (IntPtr)(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero)) throw LastError();

            string windowsRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string drive = Path.GetPathRoot(scratch).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            environment["=" + drive] = scratch;
            environment["APPDATA"] = scratch;
            environment["LOCALAPPDATA"] = scratch;
            environment["PATH"] = runtimeRoot;
            environment["SystemRoot"] = windowsRoot;
            environment["TEMP"] = scratch;
            environment["TMP"] = scratch;
            environment["USERPROFILE"] = scratch;
            environment["WINDIR"] = windowsRoot;
            string runtimeApiKey = Environment.GetEnvironmentVariable("LLAMA_API_KEY");
            if (!String.IsNullOrEmpty(runtimeApiKey))
            {
                if (runtimeApiKey.Length < 16 || runtimeApiKey.Length > 256)
                    throw new ArgumentException("invalid-runtime-api-key");
                foreach (char c in runtimeApiKey)
                    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_'))
                        throw new ArgumentException("invalid-runtime-api-key");
                environment["LLAMA_API_KEY"] = runtimeApiKey;
            }
            string ompThreads = Environment.GetEnvironmentVariable("OMP_NUM_THREADS");
            uint parsedThreads;
            if (!String.IsNullOrEmpty(ompThreads))
            {
                if (!UInt32.TryParse(ompThreads, out parsedThreads) || parsedThreads < 1 || parsedThreads > 1024)
                    throw new ArgumentException("invalid-omp-threads");
                environment["OMP_NUM_THREADS"] = parsedThreads.ToString(CultureInfo.InvariantCulture);
            }
            var environmentBlock = new StringBuilder();
            foreach (KeyValuePair<string, string> variable in environment)
                environmentBlock.Append(variable.Key).Append('=').Append(variable.Value).Append('\0');
            environmentBlock.Append('\0');
            string childEnvironment = environmentBlock.ToString();
            environmentBuffer = Marshal.StringToHGlobalUni(childEnvironment);

            currentStage = "create-process";
            var command = new StringBuilder(Quote(executable));
            foreach (string arg in arguments) command.Append(' ').Append(Quote(arg));
            var startupInfo = startup;
            ProcessInformation info;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | ExtendedStartupInfoPresent | CreateUnicodeEnvironment, environmentBuffer, scratch,
                ref startupInfo, out info)) throw LastError();
            process = info.hProcess;
            thread = info.hThread;
            currentStage = "assign-job";
            if (!AssignProcessToJobObject(job, process)) throw LastError();
            processAssigned = true;
            currentStage = "resume";
            if (ResumeThread(thread) == 0xffffffff) throw LastError();

            WriteStarted(info.dwProcessId);
            IntPtr[] waits = new[] { process, requestedStop.SafeWaitHandle.DangerousGetHandle() };
            uint wait = WaitForMultipleObjects(2, waits, false, timeoutMilliseconds);
            string termination = "exit";
            if (wait == WaitTimeout)
            {
                if (!TerminateJobAndWait(job, 124)) return Fail("job-reap-timeout", 1);
                termination = "timeout";
            }
            else if (wait == WaitObject0 + 1)
            {
                if (!TerminateJobAndWait(job, 125)) return Fail("job-reap-timeout", 1);
                termination = "stop";
            }
            else if (wait != WaitObject0) throw LastError();
            uint exitCode = 0;
            if (!GetExitCodeProcess(process, out exitCode)) throw LastError();
            if (!TerminateJobAndWait(job, exitCode)) return Fail("job-reap-timeout", 1);
            ulong peakWorkingSetBytes = QueryPeakWorkingSet(process);
            ulong peakJobCommitBytes = QueryPeakJobCommit(job);
            if (termination == "timeout") exitCode = 124;
            if (termination == "stop") exitCode = 125;
            WriteRunStatus(info.dwProcessId, exitCode, termination, peakWorkingSetBytes, peakJobCommitBytes);
            return exitCode > 255 ? 1 : (int)exitCode;
        }
        finally
        {
            if (process != IntPtr.Zero && !processAssigned) TerminateAndWaitProcess(process, 126);
            if (job != IntPtr.Zero)
            {
                if (!TerminateJobAndWait(job, 126)) cleanupUnsafe = true;
                CloseHandle(job); // KILL_ON_JOB_CLOSE is the final containment fallback.
            }
            if (process != IntPtr.Zero) CloseHandle(process);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (nullIn != IntPtr.Zero && nullIn != new IntPtr(-1)) CloseHandle(nullIn);
            if (nullOut != IntPtr.Zero && nullOut != new IntPtr(-1)) CloseHandle(nullOut);
            if (attrList != IntPtr.Zero) DeleteProcThreadAttributeList(attrList);
            if (attrList != IntPtr.Zero) Marshal.FreeHGlobal(attrList);
            if (attrBuffer != IntPtr.Zero) Marshal.FreeHGlobal(attrBuffer);
            if (handlesBuffer != IntPtr.Zero) Marshal.FreeHGlobal(handlesBuffer);
            if (environmentBuffer != IntPtr.Zero) Marshal.FreeHGlobal(environmentBuffer);
        }
    }

    private static IntPtr CreateAppContainer(string name)
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, "Excess Worker Runtime", "Restricted model runtime", IntPtr.Zero, 0, out sid);
        if (hr == 0) return sid;
        throw new Win32Exception(hr & 0xffff);
    }

    private static bool DeleteAppContainerProfile(string name)
    {
        return DeleteAppContainerProfileNative(name) == 0;
    }

    private static bool DeletePrivateScratch(string root, string path)
    {
        try
        {
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(path);
            string expectedPrefix = fullRoot + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase) ||
                !RegexMatch(Path.GetFileName(fullPath), "^session-[0-9a-fA-F]{32}$")) return false;
            if (Directory.Exists(fullPath)) { RejectReparsePath(fullPath); Directory.Delete(fullPath, true); }
            return !Directory.Exists(fullPath);
        }
        catch { return false; }
    }

    private static FileStream OpenPinnedFile(string path)
    {
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    }

    private static bool HashMatches(FileStream stream, string expected)
    {
        stream.Position = 0;
        using (var sha = SHA256.Create())
        {
            byte[] buffer = new byte[1024 * 1024];
            int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                CheckSetup();
                sha.TransformBlock(buffer, 0, count, buffer, 0);
            }
            sha.TransformFinalBlock(new byte[0], 0, 0);
            byte[] hash = sha.Hash;
            var actual = new StringBuilder(hash.Length * 2);
            foreach (byte value in hash) actual.Append(value.ToString("x2"));
            stream.Position = 0;
            return String.Equals(actual.ToString(), expected, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static void RejectReparsePath(string path)
    {
        string full = Path.GetFullPath(path);
        string root = Path.GetPathRoot(full);
        string current = root;
        string remainder = full.Substring(root.Length).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string[] parts = remainder.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string part in parts)
        {
            current = Path.Combine(current, part);
            FileAttributes attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("reparse-path");
        }
    }

    private static int ProbeConnect(string[] args)
    {
        if (Environment.GetEnvironmentVariable("EXCESS_SANDBOX_SENTINEL") != null) return 45;
        if (Environment.GetEnvironmentVariable("LLAMA_API_KEY") != "probe-runtime-key-123456" ||
            Environment.GetEnvironmentVariable("OMP_NUM_THREADS") != "4") return 55;
        try { File.WriteAllText(Path.Combine(Environment.CurrentDirectory, "probe.tmp"), "ok"); }
        catch { return 46; }
        if (args.Length != 8) return 40;
        try { Directory.GetFiles(args[3]); }
        catch { return 47; }
        try { File.ReadAllText(args[4]); return 48; }
        catch (UnauthorizedAccessException) { }
        catch { return 50; }
        try
        {
            if (File.ReadAllText(args[5]) != "approved model fixture") return 51;
        }
        catch { return 51; }
        try { File.ReadAllText(args[6]); return 52; }
        catch (UnauthorizedAccessException) { }
        catch { return 53; }
        try { Directory.GetFiles(args[7]); return 56; }
        catch (UnauthorizedAccessException) { }
        catch { return 57; }
        if (!VerifyProcessLimit()) return 54;
        System.Net.IPAddress address;
        ushort port;
        if (!System.Net.IPAddress.TryParse(args[1], out address) ||
            !ushort.TryParse(args[2], out port)) return 40;
        using (var client = new TcpClient(address.AddressFamily))
        {
            IAsyncResult attempt = null;
            try
            {
                attempt = client.BeginConnect(address, port, null, null);
                if (!attempt.AsyncWaitHandle.WaitOne(2500)) return 42;
                client.EndConnect(attempt);
                return 41;
            }
            catch (SocketException) { return 43; }
            catch { return 44; }
            finally { if (attempt != null) attempt.AsyncWaitHandle.Close(); }
        }
    }

    private static int ProbeHttpServer(string[] args)
    {
        if (args.Length != 2) return 70;
        int port; if (!Int32.TryParse(args[1], out port) || port < 1 || port > 65535) return 70;
        string expectedKey = Environment.GetEnvironmentVariable("LLAMA_API_KEY");
        var listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            listener.Start(1);
            while (true)
            {
                using (TcpClient client = listener.AcceptTcpClient())
                using (NetworkStream stream = client.GetStream())
                {
                    stream.ReadTimeout = 10000;
                    var headerBytes = new List<byte>();
                    int match = 0;
                    while (headerBytes.Count < 8192 && match < 4)
                    {
                        int value = stream.ReadByte(); if (value < 0) return 71;
                        headerBytes.Add((byte)value);
                        byte expected = match == 0 || match == 2 ? (byte)'\r' : (byte)'\n';
                        if (value == expected) match++; else match = value == '\r' ? 1 : 0;
                    }
                    if (match != 4) return 72;
                    string headers = Encoding.ASCII.GetString(headerBytes.ToArray());
                    string first = headers.Split(new[] { "\r\n" }, StringSplitOptions.None)[0];
                    string[] requestParts = first.Split(' ');
                    int length = 0;
                    foreach (string line in headers.Split(new[] { "\r\n" }, StringSplitOptions.None))
                    {
                        if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                            Int32.TryParse(line.Substring(15).Trim(), out length);
                    }
                    if (length < 0 || length > 16 * 1024 * 1024) return 73;
                    byte[] requestBody = new byte[length]; int consumed = 0;
                    while (consumed < length) { int count = stream.Read(requestBody, consumed, length - consumed); if (count <= 0) return 74; consumed += count; }
                    bool authorized = !String.IsNullOrEmpty(expectedKey) && headers.IndexOf("Authorization: Bearer " + expectedKey, StringComparison.OrdinalIgnoreCase) >= 0;
                    int status = authorized && requestParts.Length == 3 && requestParts[0] == "POST" && requestParts[1] == "/completion" ? 200 : 401;
                    string responseBody = status == 200 ? "data: {\"ok\":true}\n\n" : "denied";
                    byte[] bodyBytes = Encoding.UTF8.GetBytes(responseBody);
                    string contentType = status == 200 ? "text/event-stream" : "text/plain";
                    byte[] responseHeaders = Encoding.ASCII.GetBytes("HTTP/1.1 " + status.ToString(CultureInfo.InvariantCulture) + (status == 200 ? " OK" : " Unauthorized") + "\r\nContent-Type: " + contentType + "\r\nContent-Length: " + bodyBytes.Length.ToString(CultureInfo.InvariantCulture) + "\r\nConnection: close\r\n\r\n");
                    stream.Write(responseHeaders, 0, responseHeaders.Length); stream.Write(bodyBytes, 0, bodyBytes.Length); stream.Flush();
                }
            }
        }
        catch (SocketException ex) { return ex.ErrorCode; }
        catch (IOException) { return 75; }
        finally { listener.Stop(); }
    }

    private static int ProbeListen(string[] args)
    {
        if (args.Length != 2) return 60;
        ushort port;
        if (!ushort.TryParse(args[1], out port) || port == 0) return 60;
        var listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            listener.Start(1);
            var accepted = listener.AcceptTcpClientAsync();
            if (!accepted.Wait(3000))
            {
                listener.Stop();
                try { accepted.Wait(1000); }
                catch (AggregateException) { }
                return 10060; // WSAETIMEDOUT: bound, but no outside client reached the listener.
            }
            using (TcpClient client = accepted.GetAwaiter().GetResult())
            using (NetworkStream stream = client.GetStream())
            {
                byte[] response = Encoding.ASCII.GetBytes("contained\n");
                stream.Write(response, 0, response.Length);
                stream.Flush();
            }
            return 0;
        }
        catch (SocketException ex)
        {
            return ex.ErrorCode; // Preserve the exact Winsock error in the launcher status line.
        }
        catch (AggregateException ex)
        {
            var socketError = ex.InnerException as SocketException;
            return socketError == null ? 60 : socketError.ErrorCode;
        }
        catch
        {
            return 60;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static int ProbeIntraLoopback(string[] args)
    {
        if (args.Length != 2) return 61;
        ushort port;
        if (!ushort.TryParse(args[1], out port) || port == 0) return 61;
        var start = new ProcessStartInfo
        {
            FileName = System.Reflection.Assembly.GetExecutingAssembly().Location,
            Arguments = "--probe-listen " + port.ToString(CultureInfo.InvariantCulture),
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Environment.CurrentDirectory
        };
        Process server = null;
        try
        {
            server = Process.Start(start);
            if (server == null) return 30062;
            SocketException lastSocketError = null;
            long deadline = Environment.TickCount + 2500;
            while (Environment.TickCount < deadline)
            {
                var client = new TcpClient(AddressFamily.InterNetwork);
                IAsyncResult attempt = null;
                try
                {
                    attempt = client.BeginConnect(IPAddress.Loopback, port, null, null);
                    if (!attempt.AsyncWaitHandle.WaitOne(300))
                    {
                        client.Close();
                        Thread.Sleep(50);
                        if (server.HasExited) return 10000 + server.ExitCode;
                        continue;
                    }
                    client.EndConnect(attempt);
                    using (NetworkStream stream = client.GetStream())
                    {
                        stream.ReadTimeout = 2000;
                        var response = new byte[32];
                        int count = stream.Read(response, 0, response.Length);
                        string text = Encoding.ASCII.GetString(response, 0, count);
                        if (text != "contained\n") return 63;
                    }
                    if (!server.WaitForExit(2000)) return 64;
                    return server.ExitCode == 0 ? 0 : 10000 + server.ExitCode;
                }
                catch (SocketException ex) { lastSocketError = ex; }
                finally
                {
                    if (attempt != null) attempt.AsyncWaitHandle.Close();
                    client.Close();
                }
                if (server.HasExited) return 10000 + server.ExitCode;
                Thread.Sleep(50);
            }
            return lastSocketError == null ? 30060 : 20000 + lastSocketError.ErrorCode;
        }
        catch (Win32Exception ex) { return 30000 + ex.NativeErrorCode; }
        catch { return 66; }
        finally
        {
            if (server != null)
            {
                try { if (!server.HasExited) server.Kill(); }
                catch { }
                try { server.WaitForExit(); }
                catch { }
                server.Dispose();
            }
        }
    }

    private static bool VerifyProcessLimit()
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = System.Reflection.Assembly.GetExecutingAssembly().Location,
                Arguments = "--probe-idle",
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (Process child = Process.Start(start))
            {
                if (child == null) return false;
                child.Kill();
                child.WaitForExit();
                return false;
            }
        }
        catch (Win32Exception ex)
        {
            return ex.NativeErrorCode == 1816;
        }
        catch { return false; }
    }

    private static string RequiredString(Dictionary<string, object> value, string key)
    {
        object result;
        if (!value.TryGetValue(key, out result) || !(result is string) || String.IsNullOrWhiteSpace((string)result))
            throw new ArgumentException("missing-config");
        return (string)result;
    }

    private static ulong RequiredUInt64(Dictionary<string, object> value, string key)
    {
        object result;
        ulong parsed;
        if (!value.TryGetValue(key, out result) || !UInt64.TryParse(Convert.ToString(result), out parsed))
            throw new ArgumentException("missing-limit");
        return parsed;
    }

    private static string[] OptionalStringArray(Dictionary<string, object> value, string key)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || raw == null) return new string[0];
        var list = raw as System.Collections.IEnumerable;
        if (list == null || raw is string) throw new ArgumentException("invalid-list");
        var result = new List<string>();
        foreach (object item in list)
        {
            string itemText = item as string;
            if (itemText == null) throw new ArgumentException("invalid-list-item");
            result.Add(itemText);
        }
        return result.ToArray();
    }

    private static RuntimeFile[] RequiredRuntimeFiles(Dictionary<string, object> value, string key)
    {
        object raw;
        if (!value.TryGetValue(key, out raw)) throw new ArgumentException("missing-runtime-files");
        var items = raw as System.Collections.IEnumerable;
        if (items == null || raw is string) throw new ArgumentException("invalid-runtime-files");
        var result = new List<RuntimeFile>();
        foreach (object item in items)
        {
            var entry = item as Dictionary<string, object>;
            if (entry == null) throw new ArgumentException("invalid-runtime-entry");
            string path = RequiredString(entry, "path");
            string hash = RequiredString(entry, "sha256");
            if (hash.Length != 64) throw new ArgumentException("invalid-runtime-hash");
            foreach (char c in hash) if (!Uri.IsHexDigit(c)) throw new ArgumentException("invalid-runtime-hash");
            result.Add(new RuntimeFile { Path = path, Sha256 = hash });
        }
        if (result.Count == 0 || result.Count > 512) throw new ArgumentException("invalid-runtime-count");
        return result.ToArray();
    }

    private static bool IsWithin(string root, string candidate)
    {
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
            String.Equals(root, candidate, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class RuntimeFile
    {
        public string Path;
        public string Sha256;
    }

    private sealed class AclLease
    {
        private readonly List<Action> restoreActions = new List<Action>();
        private readonly HashSet<string> savedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly SecurityIdentifier packageSid;

        public AclLease(SecurityIdentifier sid) { packageSid = sid; }

        public void GrantDirectory(SecurityIdentifier sid, string path, FileSystemRights rights, bool recursive)
        {
            var info = new DirectoryInfo(path);
            DirectorySecurity original = info.GetAccessControl(AccessControlSections.Access);
            Save(path, delegate
            {
                DirectorySecurity current = info.GetAccessControl(AccessControlSections.Access);
                current.PurgeAccessRules(packageSid);
                info.SetAccessControl(current);
                info.SetAccessControl(original);
            });
            DirectorySecurity security = info.GetAccessControl(AccessControlSections.Access);
            InheritanceFlags inheritance = recursive ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
            security.AddAccessRule(new FileSystemAccessRule(sid, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
            info.SetAccessControl(security);
        }

        public void GrantFile(SecurityIdentifier sid, string path, FileSystemRights rights)
        {
            var info = new FileInfo(path);
            FileSecurity original = info.GetAccessControl(AccessControlSections.Access);
            Save(path, delegate
            {
                FileSecurity current = info.GetAccessControl(AccessControlSections.Access);
                current.PurgeAccessRules(packageSid);
                info.SetAccessControl(current);
                info.SetAccessControl(original);
            });
            FileSecurity security = info.GetAccessControl(AccessControlSections.Access);
            security.AddAccessRule(new FileSystemAccessRule(sid, rights, AccessControlType.Allow));
            info.SetAccessControl(security);
        }

        private void Save(string path, Action restore)
        {
            if (savedPaths.Add(Path.GetFullPath(path))) restoreActions.Add(restore);
        }

        public bool Restore()
        {
            bool okay = true;
            for (int i = restoreActions.Count - 1; i >= 0; i--)
            {
                try { restoreActions[i](); }
                catch { okay = false; }
            }
            return okay;
        }
    }

    private static void RejectProtectedPath(string path)
    {
        string normalized = Path.GetFullPath(path).Replace('/', '\\');
        string volumeRoot = Path.GetPathRoot(normalized);
        string[] protectedSegments = { "Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users", "System Volume Information" };
        string[] segments = normalized.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        bool protectedSegment = false;
        foreach (string segment in segments)
        {
            foreach (string blocked in protectedSegments)
                if (String.Equals(segment, blocked, StringComparison.OrdinalIgnoreCase)) protectedSegment = true;
        }
        if (normalized.StartsWith("\\\\", StringComparison.Ordinal) || protectedSegment ||
            String.Equals(normalized.TrimEnd('\\'), volumeRoot.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("protected-path");
    }

    private static void RejectPinnedFilePath(string path)
    {
        string normalized = Path.GetFullPath(path).Replace('/', '\\');
        string root = Path.GetPathRoot(normalized);
        RejectPinnedSegments(normalized);
        if (normalized.StartsWith("\\\\", StringComparison.Ordinal) ||
            String.Equals(normalized.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("protected-pinned-path");
    }

    private static void RejectPinnedDirectoryPath(string path)
    {
        string normalized = Path.GetFullPath(path).Replace('/', '\\');
        string root = Path.GetPathRoot(normalized);
        RejectPinnedSegments(normalized);
        if (normalized.StartsWith("\\\\", StringComparison.Ordinal) ||
            String.Equals(normalized.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("protected-pinned-directory");
    }

    private static void RejectUserTreeRelayPath(string path)
    {
        string local = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string profile = Directory.GetParent(local).FullName.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string profilePrefix = profile + Path.DirectorySeparatorChar;
        string installedAppPrefix = Path.Combine(local, "EXCESS", "app") + Path.DirectorySeparatorChar;
        string normalized = Path.GetFullPath(path);
        if (normalized.StartsWith(profilePrefix, StringComparison.OrdinalIgnoreCase) &&
            !normalized.StartsWith(installedAppPrefix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("relay-helper-not-neutral-or-installed");
    }

    private static void RejectPinnedSegments(string normalized)
    {
        string[] forbidden = { "Windows", "Program Files", "Program Files (x86)", "ProgramData", "System Volume Information",
            "Credentials", ".ssh", ".aws", ".azure", "OneDrive", "Desktop", "Documents", "Pictures", "Videos" };
        foreach (string segment in normalized.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
            foreach (string blocked in forbidden)
                if (String.Equals(segment, blocked, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("protected-pinned-path");
    }

    private static void ValidatePrivateScratchRoot(string path)
    {
        string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        RejectPinnedDirectoryPath(full);
        string local = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string localPrefix = Path.Combine(local, "EXCESS", "runtime-scratch") + Path.DirectorySeparatorChar;
        string testPrefix = "C:\\ExcessBuilds\\tools\\excess-sandbox-runs\\";
        bool approved = full.StartsWith(localPrefix, StringComparison.OrdinalIgnoreCase) &&
            RegexMatch(Path.GetFileName(full), "^excess-runtime-[0-9a-fA-F]{32}$");
        if (!approved && full.StartsWith(testPrefix, StringComparison.OrdinalIgnoreCase))
        {
            string relative = full.Substring(testPrefix.Length).Replace('/', '\\');
            string[] parts = relative.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            approved = parts.Length == 2 && RegexMatch(parts[0], "^[0-9a-fA-F]{32}$") && parts[1] == "scratch";
        }
        if (!approved) throw new ArgumentException("unapproved-scratch-root");
        RejectReparsePath(full);
        var info = new DirectoryInfo(full);
        if (!info.Exists || info.GetFileSystemInfos().Length != 0) throw new ArgumentException("scratch-not-empty");
        SecurityIdentifier owner = (SecurityIdentifier)info.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier));
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        if (owner == null || current == null || !owner.Equals(current)) throw new ArgumentException("scratch-owner-mismatch");
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { current.Value, "S-1-5-18", "S-1-5-32-544", "S-1-3-0" };
        AuthorizationRuleCollection rules = info.GetAccessControl(AccessControlSections.Access)
            .GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in rules)
        {
            var identity = rule.IdentityReference as SecurityIdentifier;
            if (identity == null || !allowed.Contains(identity.Value)) throw new ArgumentException("scratch-acl-not-private");
        }
    }

    private static void RequireCurrentUserOwnedDirectory(string path)
    {
        var directory = new DirectoryInfo(path);
        if (!directory.Exists) throw new ArgumentException("pinned-directory-missing");
        var owner = directory.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        var current = WindowsIdentity.GetCurrent().User;
        if (owner == null || current == null || !owner.Equals(current))
            throw new ArgumentException("pinned-directory-owner-mismatch");
    }

    private static bool RegexMatch(string value, string pattern)
    {
        return System.Text.RegularExpressions.Regex.IsMatch(value ?? String.Empty, pattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static void StartStatusOutput()
    {
        statusOutput = new BlockingCollection<string>(new ConcurrentQueue<string>(), 4);
        var writer = new Thread(() =>
        {
            try
            {
                foreach (string line in statusOutput.GetConsumingEnumerable())
                {
                    try { Console.Out.WriteLine(line); Console.Out.Flush(); }
                    catch { statusOutputFailed = true; stopReasonCode = "parent-output-unavailable"; stopEvent.Set(); break; }
                }
            }
            finally { statusOutputDone.Set(); }
        });
        writer.IsBackground = true;
        writer.Name = "sandbox-status-output";
        writer.Start();
    }

    private static bool TryEmitOutput(string line)
    {
        if (statusOutput == null || statusOutputFailed) return false;
        try
        {
            if (statusOutput.TryAdd(line, 0)) return true;
        }
        catch (InvalidOperationException) { }
        statusOutputFailed = true;
        stopReasonCode = "parent-output-unavailable";
        stopEvent.Set();
        return false;
    }

    private static void CompleteStatusOutput()
    {
        try { if (statusOutput != null) statusOutput.CompleteAdding(); } catch { }
        statusOutputDone.WaitOne(300);
    }

    private static int Fail(string status, int code)
    {
        TryEmitOutput("{\"type\":\"error\",\"code\":\"" + SafeCode(status) + "\",\"win32\":" + code.ToString(CultureInfo.InvariantCulture) + "}");
        return 1;
    }

    private static void WriteDiagnosticPhase(string phase)
    {
        if (Environment.GetEnvironmentVariable("EXCESS_SANDBOX_DIAGNOSTIC") != "1") return;
        TryEmitOutput("{\"type\":\"diagnosticPhase\",\"phase\":\"" + SafeCode(phase) + "\"}");
    }

    private static string SafeCode(string value)
    {
        var safe = new StringBuilder();
        foreach (char c in value)
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') safe.Append(c);
        return safe.Length == 0 ? "failure" : safe.ToString();
    }

    private static bool ReadBoundedLine(TextReader reader, int maximum, out string line)
    {
        var value = new StringBuilder();
        bool overflow = false;
        bool any = false;
        for (;;)
        {
            int next = reader.Read();
            if (next < 0)
            {
                if (!any || overflow) { line = null; return false; }
                break;
            }
            any = true;
            if (next == '\n') break;
            if (value.Length < maximum) value.Append((char)next);
            else { overflow = true; break; }
        }
        if (overflow) { line = null; return false; }
        if (value.Length > 0 && value[value.Length - 1] == '\r') value.Length--;
        line = value.ToString();
        return line.Length > 0;
    }

    private static void StartControlInput()
    {
        var reader = new Thread(() =>
        {
            IntPtr input = GetStdHandle(-10);
            if (input == IntPtr.Zero || input == new IntPtr(-1))
            {
                configReadFailed = true;
                configReady.Set();
                stopReasonCode = "input-invalid";
                stopEvent.Set();
                return;
            }
            var line = new MemoryStream();
            byte[] buffer = new byte[4096];
            bool readingConfig = true;
            try
            {
                while (true)
                {
                    uint available;
                    if (!PeekNamedPipe(input, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 109 || error == 232) break;
                        configReadFailed = readingConfig;
                        stopReasonCode = "input-error";
                        stopEvent.Set();
                        return;
                    }
                    if (available == 0) { Thread.Sleep(20); continue; }
                    uint requested = available < (uint)buffer.Length ? available : (uint)buffer.Length;
                    uint read;
                    if (!ReadFile(input, buffer, requested, out read, IntPtr.Zero))
                    {
                        configReadFailed = readingConfig;
                        stopReasonCode = "input-error";
                        stopEvent.Set();
                        return;
                    }
                    if (read == 0) break;
                    for (int i = 0; i < read; i++)
                    {
                        byte value = buffer[i];
                        if (value != (byte)'\n')
                        {
                            int maximum = readingConfig ? 65536 : 32 * 1024 * 1024;
                            if (line.Length >= maximum)
                            {
                                configReadFailed = readingConfig;
                                stopReasonCode = "input-too-large";
                                stopEvent.Set();
                                configReady.Set();
                                controlLines.CompleteAdding();
                                return;
                            }
                            line.WriteByte(value);
                            continue;
                        }

                        byte[] bytes = line.ToArray();
                        line.SetLength(0);
                        int length = bytes.Length;
                        if (length > 0 && bytes[length - 1] == (byte)'\r') length--;
                        string command;
                        try { command = new UTF8Encoding(false, true).GetString(bytes, 0, length); }
                        catch
                        {
                            configReadFailed = readingConfig;
                            stopReasonCode = "input-invalid-utf8";
                            stopEvent.Set();
                            configReady.Set();
                            controlLines.CompleteAdding();
                            return;
                        }
                        if (readingConfig)
                        {
                            if (command.Length == 0)
                            {
                                configReadFailed = true;
                                configReady.Set();
                                configModeReady.Set();
                                controlLines.CompleteAdding();
                                return;
                            }
                            configLine = command;
                            readingConfig = false;
                            configReady.Set();
                            if (!configModeReady.WaitOne(5000))
                            {
                                stopReasonCode = "config-mode-timeout";
                                stopEvent.Set();
                                controlLines.CompleteAdding();
                                return;
                            }
                            continue;
                        }

                        if (command == "{\"type\":\"stop\"}")
                        {
                            stopReasonCode = "explicit-stop";
                            stopEvent.Set();
                            controlLines.CompleteAdding();
                            return;
                        }
                        if (!relayControlMode)
                        {
                            stopReasonCode = "invalid-control";
                            stopEvent.Set();
                            controlLines.CompleteAdding();
                            return;
                        }
                        if (!controlLines.TryAdd(command, 0))
                        {
                            stopReasonCode = "control-queue-full";
                            stopEvent.Set();
                            controlLines.CompleteAdding();
                            return;
                        }
                    }
                }
            }
            catch { stopReasonCode = "input-error"; }
            if (readingConfig)
            {
                configReadFailed = true;
                configReady.Set();
            }
            if (stopReasonCode == "none") stopReasonCode = "input-eof";
            stopEvent.Set();
            controlLines.CompleteAdding();
        });
        reader.IsBackground = true;
        reader.Name = "sandbox-control-input";
        reader.Start();
    }

    private static bool TryReadControlLine(out string line, int milliseconds)
    {
        try { return controlLines.TryTake(out line, milliseconds); }
        catch (InvalidOperationException) { line = null; return false; }
    }

    private static void CheckSetup()
    {
        if (stopEvent.WaitOne(0)) throw new OperationCanceledException();
        if (setupClock != null && setupClock.ElapsedMilliseconds > MaximumSetupMilliseconds)
            throw new TimeoutException("setup-deadline");
    }

    private static void WriteStarted(uint pid)
    {
        TryEmitOutput("{\"type\":\"started\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) + "}");
    }

    private static void WriteWorkingSetStatus(uint pid, ulong peakWorkingSetBytes)
    {
        TryEmitOutput("{\"type\":\"status\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) +
            ",\"peakWorkingSetBytes\":" + peakWorkingSetBytes.ToString(CultureInfo.InvariantCulture) + "}");
    }

    private static void WriteRunStatus(uint pid, uint exitCode, string termination, ulong peakWorkingSetBytes, ulong peakJobCommitBytes)
    {
        TryEmitOutput("{\"type\":\"status\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) +
            ",\"exitCode\":" + exitCode.ToString(CultureInfo.InvariantCulture) +
            ",\"termination\":\"" + SafeCode(termination) +
            "\",\"stopReason\":\"" + SafeCode(stopReasonCode) +
            "\",\"peakWorkingSetBytes\":" + peakWorkingSetBytes.ToString(CultureInfo.InvariantCulture) +
            ",\"peakJobCommitBytes\":" + peakJobCommitBytes.ToString(CultureInfo.InvariantCulture) + "}");
    }

    private static void WriteRunStatus(uint pid, uint exitCode, string termination, ulong peakWorkingSetBytes,
        ulong peakJobCommitBytes, string runtimeErrorCode)
    {
        string suffix = runtimeErrorCode == null ? String.Empty : ",\"runtimeErrorCode\":\"" + SafeCode(runtimeErrorCode) + "\"";
        TryEmitOutput("{\"type\":\"status\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) +
            ",\"exitCode\":" + exitCode.ToString(CultureInfo.InvariantCulture) +
            ",\"termination\":\"" + SafeCode(termination) +
            "\",\"stopReason\":\"" + SafeCode(stopReasonCode) +
            "\",\"peakWorkingSetBytes\":" + peakWorkingSetBytes.ToString(CultureInfo.InvariantCulture) +
            ",\"peakJobCommitBytes\":" + peakJobCommitBytes.ToString(CultureInfo.InvariantCulture) + suffix + "}");
    }

    private sealed class DiagnosticCapture
    {
        private readonly byte[] bytes;
        private int start;
        private int count;

        public DiagnosticCapture(int capacity) { bytes = new byte[capacity]; }

        public void Append(byte[] source, int offset, int length)
        {
            for (int i = 0; i < length; i++)
            {
                int index;
                if (count < bytes.Length)
                {
                    index = (start + count) % bytes.Length;
                    count++;
                }
                else
                {
                    index = start;
                    start = (start + 1) % bytes.Length;
                }
                bytes[index] = source[offset + i];
            }
        }

        public override string ToString()
        {
            var ordered = new byte[count];
            int first = Math.Min(count, bytes.Length - start);
            Buffer.BlockCopy(bytes, start, ordered, 0, first);
            if (first < count) Buffer.BlockCopy(bytes, 0, ordered, first, count - first);
            return Encoding.UTF8.GetString(ordered);
        }
    }

    private static void DrainBoundedDiagnostic(IntPtr readHandle, DiagnosticCapture captured)
    {
        try
        {
            using (var input = new FileStream(new SafeFileHandle(readHandle, false), FileAccess.Read, 4096))
            {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    captured.Append(buffer, 0, count);
                }
            }
        }
        catch { }
    }

    private static string ClassifyRuntimeDiagnostic(string diagnostic, uint exitCode)
    {
        if (exitCode == 0 || exitCode == 124 || exitCode == 125) return null;
        string value = (diagnostic ?? String.Empty).ToLowerInvariant();
        if (value.Contains("0xc0000135") || value.Contains("specified module could not be found") || value.Contains("dll not found"))
            return "runtime-dll-not-found";
        if (value.Contains("0xc0000022") || value.Contains("access is denied") || value.Contains("permission denied") || value.Contains("access denied"))
            return "runtime-access-denied";
        if (value.Contains("unknown model architecture") || value.Contains("unsupported model architecture"))
            return "model-architecture-unsupported";
        if (value.Contains("invalid magic") || value.Contains("invalid model file") || value.Contains("not a gguf"))
            return "model-file-invalid";
        if (value.Contains("failed to mmap") || value.Contains("mmap failed") || value.Contains("error mmap") ||
            value.Contains("failed to map") || value.Contains("mapping failed") || value.Contains("map view failed") ||
            value.Contains("createfilemapping failed") || value.Contains("mapviewoffile failed"))
            return "model-map-failed";
        if (value.Contains("no such file") || value.Contains("file not found") || value.Contains("cannot open model") ||
            value.Contains("failed to open") || value.Contains("unable to open") || value.Contains("error opening") ||
            value.Contains("failed to load gguf"))
            return "model-file-open-failed";
        if (value.Contains("out of memory") || value.Contains("not enough memory") || value.Contains("allocation failed") ||
            value.Contains("failed to allocate") || value.Contains("alloc failed"))
            return "runtime-memory-exhausted";
        if (value.Contains("backend") && (value.Contains("failed") || value.Contains("error") || value.Contains("not available")))
            return "runtime-backend-init-failed";
        if (value.Contains("failed to load model") || value.Contains("unable to load model") || value.Contains("model load failed"))
            return "model-load-failed";
        if (value.Contains("illegal instruction") || value.Contains("unsupported instruction"))
            return "cpu-instruction-unsupported";
        return "runtime-failure-unclassified";
    }

    private static void WriteCleanup(bool ok, string code)
    {
        TryEmitOutput(ok ? "{\"type\":\"cleanup\",\"ok\":true}" :
            "{\"type\":\"cleanup\",\"ok\":false,\"code\":\"" + SafeCode(code ?? "cleanup-failed") + "\"}");
    }

    private static ulong QueryPeakWorkingSet(IntPtr process)
    {
        var counters = new ProcessMemoryCounters { Size = (uint)Marshal.SizeOf(typeof(ProcessMemoryCounters)) };
        if (!GetProcessMemoryInfo(process, ref counters, counters.Size)) throw LastError();
        return counters.PeakWorkingSetSize.ToUInt64();
    }

    private static bool TerminateJobAndWait(IntPtr job, uint exitCode)
    {
        if (job == IntPtr.Zero) return true;
        uint state = WaitForSingleObject(job, 0);
        if (state == WaitObject0) return true;
        if (!TerminateJobObject(job, exitCode))
        {
            if (WaitForSingleObject(job, 0) == WaitObject0) return true;
            cleanupUnsafe = true;
            return false;
        }
        state = WaitForSingleObject(job, ReapTimeoutMilliseconds);
        if (state == WaitObject0) return true;
        cleanupUnsafe = true;
        return false;
    }

    private static bool TerminateAndWaitProcess(IntPtr process, uint exitCode)
    {
        if (process == IntPtr.Zero) return true;
        uint state = WaitForSingleObject(process, 0);
        if (state == WaitObject0) return true;
        if (!TerminateProcess(process, exitCode) && WaitForSingleObject(process, 0) != WaitObject0)
        {
            cleanupUnsafe = true;
            return false;
        }
        state = WaitForSingleObject(process, ReapTimeoutMilliseconds);
        if (state == WaitObject0) return true;
        cleanupUnsafe = true;
        return false;
    }

    private static ulong QueryPeakJobCommit(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, IntPtr.Zero))
                throw LastError();
            return Marshal.PtrToStructure<JobExtendedLimitInformation>(buffer).PeakJobMemoryUsed.ToUInt64();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static Win32Exception LastError() { return new Win32Exception(Marshal.GetLastWin32Error()); }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
    {
        public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfo
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars;
        public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public short wShowWindow;
        public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityCapabilities { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation; public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessMemoryCounters
    {
        public uint Size; public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize; public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage; public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage; public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage; public UIntPtr PeakPagefileUsage;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "DeleteAppContainerProfile")]
    private static extern int DeleteAppContainerProfileNative(string name);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref StartupInfoEx startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PeekNamedPipe(IntPtr handle, IntPtr buffer, uint bufferSize, IntPtr bytesRead, out uint totalBytesAvailable, IntPtr bytesLeftThisMessage);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ReadFile(IntPtr handle, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length, IntPtr returnLength);
    [DllImport("psapi.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessMemoryInfo(IntPtr process, ref ProcessMemoryCounters counters, uint size);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
