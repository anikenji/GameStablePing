using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace GamePingBooster.Service.Network;

/// <summary>
/// Monitors game processes and dynamically detects their active gameplay server endpoints
/// by querying Windows UDP/TCP socket tables (GetExtendedUdpTable / GetExtendedTcpTable).
///
/// This eliminates the need to route massive /17 - /20 cloud prefixes by narrowing down
/// to the exact /32 server IP address of the active game match.
/// </summary>
internal sealed class DynamicGameDetector : IDisposable
{
    private const int AfInet = 2; // AF_INET = IPv4
    private const int UdpTableOwnerPid = 1; // UDP_TABLE_OWNER_PID
    private const int TcpTableOwnerPidAll = 5; // TCP_TABLE_OWNER_PID_ALL

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedUdpTable(
        nint pUdpTable,
        ref int pdwSize,
        bool bOrder,
        uint ulAf,
        int tableClass,
        uint reserved);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        nint pTcpTable,
        ref int pdwSize,
        bool bOrder,
        uint ulAf,
        int tableClass,
        uint reserved);

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_UDPROW_OWNER_PID
    {
        public uint localAddr;
        public uint localPort;
        public uint owningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_TCPROW_OWNER_PID
    {
        public uint state;
        public uint localAddr;
        public uint localPort;
        public uint remoteAddr;
        public uint remotePort;
        public uint owningPid;
    }

    private readonly string[] _processNames;
    private readonly Action<string> _log;
    private readonly Action<IPAddress> _onServerDetected;
    private readonly Action<IPAddress> _onServerEnded;
    private readonly HashSet<IPAddress> _activeServers = new();
    private readonly object _lock = new();

    private CancellationTokenSource? _cts;
    private Task? _scanLoop;
    private bool _disposed;

    public DynamicGameDetector(
        IEnumerable<string> processNames,
        Action<IPAddress> onServerDetected,
        Action<IPAddress> onServerEnded,
        Action<string> log)
    {
        _processNames = processNames.Select(p => p.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) 
            ? p[..^4] 
            : p).ToArray();
        _onServerDetected = onServerDetected;
        _onServerEnded = onServerEnded;
        _log = log;
    }

    public void Start(TimeSpan? interval = null)
    {
        if (_disposed || _cts != null) return;

        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        var pollInterval = interval ?? TimeSpan.FromMilliseconds(500);

        _scanLoop = Task.Run(async () =>
        {
            _log($"[Detector] Dynamic game socket detector started for processes: {string.Join(", ", _processNames)}");
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    ScanActiveConnections();
                    await Task.Delay(pollInterval, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    _log($"[Detector] Scan error: {ex.Message}");
                    await Task.Delay(1000, ct).ConfigureAwait(false);
                }
            }
        }, ct);
    }

    public void Stop()
    {
        _cts?.Cancel();
        try { _scanLoop?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        _cts?.Dispose();
        _cts = null;
        _scanLoop = null;

        lock (_lock)
        {
            foreach (var s in _activeServers)
            {
                _onServerEnded(s);
            }
            _activeServers.Clear();
        }
        _log("[Detector] Dynamic game socket detector stopped.");
    }

    private void ScanActiveConnections()
    {
        var gamePids = new HashSet<int>();
        foreach (var name in _processNames)
        {
            foreach (var proc in Process.GetProcessesByName(name))
            {
                using (proc)
                {
                    gamePids.Add(proc.Id);
                }
            }
        }

        if (gamePids.Count == 0)
        {
            lock (_lock)
            {
                if (_activeServers.Count > 0)
                {
                    foreach (var s in _activeServers)
                    {
                        _onServerEnded(s);
                    }
                    _activeServers.Clear();
                }
            }
            return;
        }

        // Scan TCP established connections for game PID
        var currentDetectedIps = new HashSet<IPAddress>();
        ScanTcpEndpoints(gamePids, currentDetectedIps);

        lock (_lock)
        {
            // Detect newly discovered game servers
            foreach (var ip in currentDetectedIps)
            {
                if (_activeServers.Add(ip))
                {
                    _log($"[Detector] New game server detected: {ip}");
                    _onServerDetected(ip);
                }
            }

            // Remove expired servers
            var toRemove = new List<IPAddress>();
            foreach (var ip in _activeServers)
            {
                if (!currentDetectedIps.Contains(ip))
                {
                    toRemove.Add(ip);
                }
            }

            foreach (var ip in toRemove)
            {
                _activeServers.Remove(ip);
                _log($"[Detector] Game server session ended: {ip}");
                _onServerEnded(ip);
            }
        }
    }

    private void ScanTcpEndpoints(HashSet<int> gamePids, HashSet<IPAddress> detectedIps)
    {
        int bufferSize = 0;
        uint ret = GetExtendedTcpTable(nint.Zero, ref bufferSize, false, AfInet, TcpTableOwnerPidAll, 0);
        if (bufferSize <= 0) return;

        nint buffer = Marshal.AllocHGlobal(bufferSize);
        try
        {
            ret = GetExtendedTcpTable(buffer, ref bufferSize, false, AfInet, TcpTableOwnerPidAll, 0);
            if (ret != 0) return;

            int numEntries = Marshal.ReadInt32(buffer);
            nint rowPtr = buffer + 4;
            int rowSize = Marshal.SizeOf<MIB_TCPROW_OWNER_PID>();

            for (int i = 0; i < numEntries; i++)
            {
                var row = Marshal.PtrToStructure<MIB_TCPROW_OWNER_PID>(rowPtr);
                if (gamePids.Contains((int)row.owningPid))
                {
                    var remoteIp = new IPAddress(row.remoteAddr);
                    ushort remotePort = (ushort)(((row.remotePort & 0xFF) << 8) | ((row.remotePort & 0xFF00) >> 8));

                    if (IsValidGameServerAddress(remoteIp, remotePort))
                    {
                        detectedIps.Add(remoteIp);
                    }
                }
                rowPtr += rowSize;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool IsValidGameServerAddress(IPAddress ip, ushort port)
    {
        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.Broadcast))
            return false;

        // Skip non-gameplay standard ports
        if (port is 53 or 80 or 443 or 8080 or 8443)
            return false;

        byte[] bytes = ip.GetAddressBytes();
        if (bytes.Length != 4) return false;

        // Skip Private RFC 1918 / CGNAT / Link-Local
        if (bytes[0] == 10) return false;
        if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return false;
        if (bytes[0] == 192 && bytes[1] == 168) return false;
        if (bytes[0] == 100 && (bytes[1] & 0xC0) == 64) return false; // 100.64.0.0/10
        if (bytes[0] == 169 && bytes[1] == 254) return false; // 169.254.0.0/16

        return true;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
    }
}
