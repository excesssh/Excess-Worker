using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class ExcessSandbox
{
    private static string currentStage = "config";
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

        var pinnedFiles = new List<FileStream>();
        try
        {
            string input = Console.In.ReadToEnd();
            if (input.Length == 0 || input.Length > 65536)
                return Fail("invalid-config", 2);

            var serializer = new JavaScriptSerializer { MaxJsonLength = 65536 };
            var config = serializer.Deserialize<Dictionary<string, object>>(input);
            if (config == null)
                return Fail("invalid-config", 2);

            currentStage = "config-executable";
            string executable = RequiredString(config, "executable");
            currentStage = "config-runtime";
            string runtimeRoot = RequiredString(config, "runtimeRoot");
            currentStage = "config-scratch";
            string scratchRoot = RequiredString(config, "scratchDirectory");
            currentStage = "config-runtime-files";
            RuntimeFile[] runtimeFiles = RequiredRuntimeFiles(config, "runtimeFiles");
            currentStage = "config-models";
            string[] modelFiles = OptionalStringArray(config, "modelFiles");
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
            foreach (RuntimeFile runtimeFile in runtimeFiles)
            {
                runtimeFile.Path = Path.GetFullPath(runtimeFile.Path);
                if (!File.Exists(runtimeFile.Path) || !IsWithin(runtimeRoot, runtimeFile.Path))
                    return Fail("invalid-runtime-file", 2);
                RejectProtectedPath(runtimeFile.Path);
                RejectReparsePath(runtimeFile.Path);
                FileStream pinnedRuntime = OpenPinnedFile(runtimeFile.Path);
                pinnedFiles.Add(pinnedRuntime);
                if (!HashMatches(pinnedRuntime, runtimeFile.Sha256))
                    return Fail("runtime-hash-mismatch", 2);
                if (String.Equals(runtimeFile.Path, executable, StringComparison.OrdinalIgnoreCase)) executablePinned = true;
            }
            if (!executablePinned) return Fail("executable-not-pinned", 2);

            foreach (string model in modelFiles)
            {
                string fullModel = Path.GetFullPath(model);
                if (!File.Exists(fullModel))
                    return Fail("model-file-missing", 2);
                RejectProtectedPath(fullModel);
                RejectReparsePath(fullModel);
                pinnedFiles.Add(OpenPinnedFile(fullModel));
            }
            RejectProtectedPath(runtimeRoot);
            RejectProtectedPath(scratchRoot);

            currentStage = "profile";
            string appContainerName = "Excess.Worker.Runtime." + Guid.NewGuid().ToString("N");
            IntPtr appContainerSid = CreateAppContainer(appContainerName);
            string scratch = Path.Combine(scratchRoot, "session-" + Guid.NewGuid().ToString("N"));
            SecurityIdentifier packageSid = null;
            AclLease aclLease = null;
            int childResult = 1;
            bool aclRestored = false;
            bool profileDeleted = false;
            bool scratchDeleted = false;
            try
            {
                packageSid = new SecurityIdentifier(appContainerSid);
                aclLease = new AclLease(packageSid);
                Directory.CreateDirectory(scratch);
                RejectReparsePath(scratch);
                currentStage = "runtime-acl";
                GrantTraversal(aclLease, packageSid, runtimeRoot);
                foreach (RuntimeFile runtimeFile in runtimeFiles)
                    aclLease.GrantFile(packageSid, runtimeFile.Path, FileSystemRights.ReadAndExecute);
                currentStage = "model-acl";
                foreach (string model in modelFiles)
                {
                    string fullModel = Path.GetFullPath(model);
                    aclLease.GrantFile(packageSid, fullModel, FileSystemRights.Read);
                    GrantTraversal(aclLease, packageSid, Path.GetDirectoryName(fullModel));
                }
                currentStage = "scratch-acl";
                GrantTraversal(aclLease, packageSid, Path.GetDirectoryName(scratch));
                aclLease.GrantDirectory(packageSid, scratch, FileSystemRights.Modify, true);

                currentStage = "launch";
                childResult = RunInContainer(packageSid, appContainerSid, executable, runtimeRoot, scratch,
                    childArguments, memoryLimitBytes, processLimit, timeoutMilliseconds);
            }
            finally
            {
                currentStage = "cleanup";
                aclRestored = aclLease == null || aclLease.Restore();
                scratchDeleted = DeletePrivateScratch(scratch);
                profileDeleted = DeleteAppContainerProfile(appContainerName);
                FreeSid(appContainerSid);
            }
            if (!aclRestored) return Fail("acl-cleanup-failed", 1);
            if (!scratchDeleted) return Fail("scratch-cleanup-failed", 1);
            if (!profileDeleted) return Fail("profile-cleanup-failed", 1);
            Console.WriteLine("status=cleanup-ok");
            return childResult;
        }
        catch (Win32Exception ex)
        {
            return Fail("win32-" + currentStage, ex.NativeErrorCode);
        }
        catch (Exception ex)
        {
            return Fail("sandbox-error-" + currentStage + "-" + ex.GetType().Name + "-" +
                (ex.TargetSite == null ? "unknown" : ex.TargetSite.Name), ex.HResult);
        }
        finally
        {
            foreach (FileStream file in pinnedFiles)
            {
                try { file.Dispose(); }
                catch { }
            }
        }
    }

    private static int RunInContainer(SecurityIdentifier packageSid, IntPtr packageSidPtr,
        string executable, string runtimeRoot, string scratch, string[] arguments,
        ulong memoryLimitBytes, uint processLimit, uint timeoutMilliseconds)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError();
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
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
            string childEnvironment = "=" + drive + "=" + scratch + "\0" +
                "APPDATA=" + scratch + "\0" +
                "LOCALAPPDATA=" + scratch + "\0" +
                "PATH=" + runtimeRoot + "\0" +
                "SystemRoot=" + windowsRoot + "\0" +
                "TEMP=" + scratch + "\0" +
                "TMP=" + scratch + "\0" +
                "USERPROFILE=" + scratch + "\0" +
                "WINDIR=" + windowsRoot + "\0\0";
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
            currentStage = "resume";
            if (ResumeThread(thread) == 0xffffffff) throw LastError();

            Console.WriteLine("status=started pid=" + info.dwProcessId);
            uint wait = WaitForSingleObject(process, timeoutMilliseconds);
            if (wait == WaitTimeout)
            {
                TerminateJobObject(job, 124);
                if (WaitForSingleObject(job, Infinite) != WaitObject0) throw LastError();
                Console.WriteLine("status=timed-out pid=" + info.dwProcessId + " code=124");
                return 124;
            }
            if (wait != WaitObject0) throw LastError();
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode)) throw LastError();
            if (WaitForSingleObject(job, 0) != WaitObject0)
            {
                if (!TerminateJobObject(job, exitCode)) throw LastError();
                if (WaitForSingleObject(job, Infinite) != WaitObject0) throw LastError();
            }
            Console.WriteLine("status=exited pid=" + info.dwProcessId + " code=" + exitCode);
            return exitCode > 255 ? 1 : (int)exitCode;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job); // KILL_ON_JOB_CLOSE owns child cleanup.
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

    private static bool DeletePrivateScratch(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
            return !Directory.Exists(path);
        }
        catch { return false; }
    }

    private static void GrantTraversal(AclLease lease, SecurityIdentifier sid, string directory)
    {
        DirectoryInfo current = new DirectoryInfo(Path.GetFullPath(directory));
        while (current != null && current.Parent != null)
        {
            RejectProtectedPath(current.FullName);
            lease.GrantDirectory(sid, current.FullName, FileSystemRights.Traverse, false);
            current = current.Parent;
        }
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
            byte[] hash = sha.ComputeHash(stream);
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
        try { File.WriteAllText(Path.Combine(Environment.CurrentDirectory, "probe.tmp"), "ok"); }
        catch { return 46; }
        if (args.Length != 7) return 40;
        try { Directory.GetFiles(args[3]); return 47; }
        catch (UnauthorizedAccessException) { }
        catch { return 49; }
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

    private static int Fail(string status, int code)
    {
        Console.WriteLine("status=" + status + " code=" + code);
        return 1;
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

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "DeleteAppContainerProfile")]
    private static extern int DeleteAppContainerProfileNative(string name);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref StartupInfoEx startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
