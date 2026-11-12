using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

// Project-owned Win32 bridge. It does not load a document, navigate, impersonate a user or change system policy.
public static class ZhijingParserPlatform {
  const uint KillOnClose = 0x2000, ActiveProcess = 0x8, ProcessMemory = 0x100, JobMemory = 0x200;
  const uint Infinite = 0xffffffff, Synchronize = 0x00100000, QueryLimited = 0x1000;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits BasicLimitInformation; public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct AuthzRequest { public uint DesiredAccess; public IntPtr PrincipalSelfSid, ObjectTypeList; public uint ObjectTypeListLength; public IntPtr OptionalArguments; }
  [StructLayout(LayoutKind.Sequential)] struct AuthzReply { public uint ResultListLength; public IntPtr GrantedAccessMask, SaclEvaluationResults, Error; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string directory, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ExtendedLimits limits, uint length, IntPtr returnLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint GetErrorMode();
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation result);
  [DllImport("authz.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool AuthzInitializeResourceManager(uint flags, IntPtr access, IntPtr groups, IntPtr free, string name, out IntPtr manager);
  [DllImport("authz.dll", SetLastError=true)] static extern bool AuthzInitializeContextFromSid(uint flags, IntPtr sid, IntPtr manager, IntPtr expiration, Luid identifier, IntPtr arguments, out IntPtr context);
  [DllImport("authz.dll", SetLastError=true)] static extern bool AuthzAccessCheck(uint flags, IntPtr context, ref AuthzRequest request, IntPtr audit, IntPtr descriptor, IntPtr optionalDescriptors, uint count, ref AuthzReply reply, IntPtr cache);
  [DllImport("authz.dll")] static extern bool AuthzFreeContext(IntPtr context);
  [DllImport("authz.dll")] static extern bool AuthzFreeResourceManager(IntPtr manager);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Q(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\""; }
  static long Created(IntPtr process) {
    FileTime creation, exit, kernel, user; Check(GetProcessTimes(process, out creation, out exit, out kernel, out user));
    long ticks = ((long)creation.High << 32) | creation.Low;
    return (DateTime.FromFileTimeUtc(ticks).Ticks - new DateTime(1970,1,1).Ticks) / 10000;
  }
  static void Receipt(string file, string data) {
    string next = file + ".next";
    using (FileStream stream = new FileStream(next, FileMode.Create, FileAccess.Write, FileShare.None)) {
      byte[] bytes = Encoding.UTF8.GetBytes(data); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
    }
    if (File.Exists(file)) File.Replace(next, file, null); else File.Move(next, file);
  }
  static string CommandArgument(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(character);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static IntPtr EnvironmentBlock(string[] names, string[] values) {
    SortedDictionary<string,string> entries = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    for (int index=0; index<names.Length; index++) {
      if (names[index].IndexOf('=')>=0 || names[index].IndexOf('\0')>=0 || values[index].IndexOf('\0')>=0) throw new InvalidOperationException("INVALID_ENVIRONMENT");
      entries.Add(names[index], values[index]);
    }
    StringBuilder block = new StringBuilder(); foreach (KeyValuePair<string,string> pair in entries) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
    block.Append('\0'); return Marshal.StringToHGlobalUni(block.ToString());
  }
  static string AccessProbe(byte[] descriptorBytes, string sidValue) {
    IntPtr manager=IntPtr.Zero, context=IntPtr.Zero, descriptor=IntPtr.Zero, sid=IntPtr.Zero, grant=IntPtr.Zero, error=IntPtr.Zero;
    try {
      SecurityIdentifier identity = new SecurityIdentifier(sidValue); byte[] sidBytes = new byte[identity.BinaryLength]; identity.GetBinaryForm(sidBytes,0);
      sid=Marshal.AllocHGlobal(sidBytes.Length); Marshal.Copy(sidBytes,0,sid,sidBytes.Length);
      descriptor=Marshal.AllocHGlobal(descriptorBytes.Length); Marshal.Copy(descriptorBytes,0,descriptor,descriptorBytes.Length);
      Check(AuthzInitializeResourceManager(1,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,"Zhijing parser DACL audit",out manager));
      // AUTHZ_SKIP_TOKEN_GROUPS prevents account/domain group discovery; this is a DACL check, not another user's login.
      Check(AuthzInitializeContextFromSid(2,sid,manager,IntPtr.Zero,new Luid(),IntPtr.Zero,out context));
      grant=Marshal.AllocHGlobal(4); error=Marshal.AllocHGlobal(4); Marshal.WriteInt32(grant,0); Marshal.WriteInt32(error,0);
      AuthzRequest request=new AuthzRequest(); request.DesiredAccess=3;
      AuthzReply reply=new AuthzReply(); reply.ResultListLength=1; reply.GrantedAccessMask=grant; reply.Error=error;
      Check(AuthzAccessCheck(0,context,ref request,IntPtr.Zero,descriptor,IntPtr.Zero,0,ref reply,IntPtr.Zero));
      return "{\"sid\":"+Q(sidValue)+",\"requestedReadWrite\":3,\"granted\":"+Marshal.ReadInt32(grant)+",\"error\":"+Marshal.ReadInt32(error)+"}";
    } finally {
      if(context!=IntPtr.Zero)AuthzFreeContext(context); if(manager!=IntPtr.Zero)AuthzFreeResourceManager(manager);
      foreach(IntPtr pointer in new IntPtr[]{descriptor,sid,grant,error}) if(pointer!=IntPtr.Zero)Marshal.FreeHGlobal(pointer);
    }
  }
  public static string CreatePrivateDirectory(string directory) {
    string full=Path.GetFullPath(directory), parent=Path.GetDirectoryName(full);
    if(Directory.Exists(full)||File.Exists(full)||!Directory.Exists(parent))throw new InvalidOperationException("PRIVATE_DIRECTORY_MUST_BE_NEW");
    SecurityIdentifier user=WindowsIdentity.GetCurrent().User, system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);
    DirectorySecurity security=new DirectorySecurity(); security.SetAccessRuleProtection(true,false); security.SetOwner(user);
    foreach(SecurityIdentifier sid in new SecurityIdentifier[]{user,system}) security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    byte[] initial=security.GetSecurityDescriptorBinaryForm(); IntPtr descriptorPointer=Marshal.AllocHGlobal(initial.Length);
    try {
      Marshal.Copy(initial,0,descriptorPointer,initial.Length); SecurityAttributes attributes=new SecurityAttributes();
      attributes.Length=Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Descriptor=descriptorPointer;
      // Unlike Directory.CreateDirectory, CreateDirectoryW fails on an already existing target.
      Check(CreateDirectoryW(full,ref attributes));
    } finally { Marshal.FreeHGlobal(descriptorPointer); }
    DirectorySecurity actual=Directory.GetAccessControl(full,AccessControlSections.Access|AccessControlSections.Owner);
    if(!actual.AreAccessRulesProtected||!actual.GetOwner(typeof(SecurityIdentifier)).Equals(user))throw new InvalidOperationException("PRIVATE_DIRECTORY_ACL_FAILED");
    AuthorizationRuleCollection rules=actual.GetAccessRules(true,true,typeof(SecurityIdentifier));
    if(rules.Count!=2)throw new InvalidOperationException("PRIVATE_DIRECTORY_ACL_FAILED");
    foreach(FileSystemAccessRule rule in rules) if(rule.IsInherited||rule.AccessControlType!=AccessControlType.Allow
      ||(!rule.IdentityReference.Equals(user)&&!rule.IdentityReference.Equals(system))||rule.FileSystemRights!=FileSystemRights.FullControl)
      throw new InvalidOperationException("PRIVATE_DIRECTORY_ACL_FAILED");
    byte[] descriptor=actual.GetSecurityDescriptorBinaryForm();
    return "{\"platform\":\"win32\",\"mechanism\":\"protected-DACL-on-new-directory\",\"currentSid\":"+Q(user.Value)
      +",\"systemSid\":"+Q(system.Value)+",\"sddl\":"+Q(actual.GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner))
      +",\"inheritanceProtected\":true,\"allowEntries\":2,\"currentSidProbe\":"+AccessProbe(descriptor,user.Value)
      +",\"outsideSidProbe\":"+AccessProbe(descriptor,"S-1-5-21-0-0-0-424242")
      +",\"probeBoundary\":\"Windows Authz DACL evaluation with skipped group lookup; no outside account was logged in or impersonated. No integrity label was changed.\"}";
  }
  public static int Run(string executable,string[] arguments,string directory,string[] envNames,string[] envValues,int memoryMb,uint parentPid,long parentStarted,string receipt) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,environment=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,jobList=IntPtr.Zero;
    ProcessInformation child=new ProcessInformation(); bool resumed=false,assigned=false; string phase="parent";
    long childCreated=0,parentCreated=0; uint code=78;
    try {
      // Process-local only: suppress critical-error/Windows Error Reporting dialogs in this
      // trusted wrapper and its child. CREATE_DEFAULT_ERROR_MODE is deliberately absent.
      uint suppressedErrorMode=GetErrorMode()|0x1|0x2|0x8000; SetErrorMode(suppressedErrorMode);
      if((GetErrorMode()&0x8003)!=0x8003)throw new InvalidOperationException("CHILD_ERROR_DIALOG_SUPPRESSION_FAILED");
      parent=OpenProcess(Synchronize|QueryLimited,false,parentPid); Check(parent!=IntPtr.Zero); parentCreated=Created(parent);
      if(Math.Abs(parentCreated-parentStarted)>3000 || WaitForSingleObject(parent,0)==0) throw new InvalidOperationException("PARENT_IDENTITY_CHANGED");
      DirectorySecurity taskSecurity=Directory.GetAccessControl(directory,AccessControlSections.Access|AccessControlSections.Owner);
      if(!taskSecurity.AreAccessRulesProtected||!taskSecurity.GetOwner(typeof(SecurityIdentifier)).Equals(WindowsIdentity.GetCurrent().User))
        throw new InvalidOperationException("PRIVATE_JOB_DIRECTORY_REQUIRED");
      phase="job"; job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      ExtendedLimits limits=new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags=KillOnClose|ActiveProcess|ProcessMemory|JobMemory;
      limits.BasicLimitInformation.ActiveProcessLimit=1; limits.ProcessMemoryLimit=new UIntPtr((ulong)memoryMb*1024*1024); limits.JobMemoryLimit=limits.ProcessMemoryLimit;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      ExtendedLimits verified; Check(QueryInformationJobObject(job,9,out verified,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero));
      if(verified.BasicLimitInformation.LimitFlags!=limits.BasicLimitInformation.LimitFlags || verified.BasicLimitInformation.ActiveProcessLimit!=1
        || verified.ProcessMemoryLimit!=limits.ProcessMemoryLimit || verified.JobMemoryLimit!=limits.JobMemoryLimit)throw new InvalidOperationException("JOB_LIMIT_VERIFICATION_FAILED");
      StartupInfoEx startup=new StartupInfoEx(); startup.StartupInfo.cb=(uint)Marshal.SizeOf(typeof(StartupInfoEx));
      startup.StartupInfo.dwFlags=0x100|1; startup.StartupInfo.wShowWindow=0;
      IntPtr[] standard=new IntPtr[]{GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12)};
      foreach(IntPtr handle in standard) { if(handle==IntPtr.Zero||handle==new IntPtr(-1))throw new InvalidOperationException("PIPE_HANDLE_REQUIRED"); Check(SetHandleInformation(handle,1,1)); }
      startup.StartupInfo.hStdInput=standard[0]; startup.StartupInfo.hStdOutput=standard[1]; startup.StartupInfo.hStdError=standard[2];
      IntPtr attributeSize=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeSize);
      attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,2,0,ref attributeSize)); startup.AttributeList=attributes;
      handles=Marshal.AllocHGlobal(IntPtr.Size*standard.Length); for(int index=0;index<standard.Length;index++)Marshal.WriteIntPtr(handles,index*IntPtr.Size,standard[index]);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*standard.Length),IntPtr.Zero,IntPtr.Zero));
      // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the still-suspended process in the kernel, eliminating
      // the otherwise possible orphan interval if the wrapper dies between CreateProcess and Assign.
      jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      environment=EnvironmentBlock(envNames,envValues); StringBuilder command=new StringBuilder(CommandArgument(executable));
      foreach(string argument in arguments)command.Append(' ').Append(CommandArgument(argument));
      phase="create-suspended";
      Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x80000|0x08000000,environment,directory,ref startup,out child));
      assigned=true; childCreated=Created(child.Process); phase="confirm-atomic-assignment";
      bool inJob; Check(IsProcessInJob(child.Process,job,out inJob)); if(!inJob)throw new InvalidOperationException("JOB_ASSIGNMENT_UNCONFIRMED");
      string identity="\"wrapperPid\":"+Process.GetCurrentProcess().Id+",\"wrapperCreationUtcMs\":"+Created(Process.GetCurrentProcess().Handle)+",\"childPid\":"+child.ProcessId+",\"childCreationUtcMs\":"+childCreated
        +",\"parentMonitoredPid\":"+parentPid+",\"parentCreationUtcMs\":"+parentCreated+",\"jobAssignedBeforeResume\":true,\"assignedAtomicallyAtCreation\":true,\"killOnJobClose\":true"
        +",\"activeProcessLimit\":1,\"jobMemoryBytes\":"+limits.JobMemoryLimit.ToUInt64()+",\"processMemoryBytes\":"+limits.ProcessMemoryLimit.ToUInt64()
        +",\"inheritedErrorMode\":"+GetErrorMode()+",\"errorDialogsSuppressed\":true,\"createDefaultErrorMode\":false"
        +",\"limitFlags\":"+limits.BasicLimitInformation.LimitFlags+",\"memoryMetric\":\"Windows committed-memory limits, not a working-set/RSS guarantee\"";
      Receipt(receipt,"{\"status\":\"running\","+identity+"}"); phase="resume";
      if(ResumeThread(child.Thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error()); resumed=true;
      uint waited=WaitForMultipleObjects(2,new IntPtr[]{child.Process,parent},false,Infinite); phase="wait";
      bool parentExited=waited==1;
      if(parentExited) { Check(TerminateJobObject(job,0xd012)); if(WaitForSingleObject(child.Process,10000)!=0)throw new InvalidOperationException("JOB_TERMINATION_UNCONFIRMED"); }
      else if(waited!=0)throw new Win32Exception(Marshal.GetLastWin32Error());
      Check(GetExitCodeProcess(child.Process,out code));
      ExtendedLimits peaks; Check(QueryInformationJobObject(job,9,out peaks,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero));
      Receipt(receipt,"{\"status\":"+Q(parentExited?"parent-exited":"exited")+","+identity+",\"childExitCode\":"+code
        +",\"peakJobCommittedBytes\":"+peaks.PeakJobMemoryUsed.ToUInt64()+",\"peakProcessCommittedBytes\":"+peaks.PeakProcessMemoryUsed.ToUInt64()+"}");
      return unchecked((int)code);
    } catch(Exception error) {
      if(child.Process!=IntPtr.Zero) { if(assigned)TerminateJobObject(job,0xd013); else TerminateProcess(child.Process,0xd013); WaitForSingleObject(child.Process,10000); }
      int native=error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0;
      try { Receipt(receipt,"{\"status\":\"start-failed\",\"code\":\"PARSER_WINDOWS_JOB_FAILED\",\"phase\":"+Q(phase)
        +",\"nativeError\":"+native+",\"childPid\":"+child.ProcessId+",\"childCreationUtcMs\":"+childCreated+",\"jobAssigned\":"+(assigned?"true":"false")+",\"resumed\":"+(resumed?"true":"false")+"}"); } catch { }
      return 78;
    } finally {
      if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread); if(child.Process!=IntPtr.Zero)CloseHandle(child.Process);
      if(job!=IntPtr.Zero)CloseHandle(job); if(parent!=IntPtr.Zero)CloseHandle(parent);
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles); if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList); if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
    }
  }
}
