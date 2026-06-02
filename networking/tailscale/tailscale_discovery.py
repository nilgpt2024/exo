import asyncio
import time
import traceback
from typing import List, Dict, Callable, Tuple, Optional
from exo.networking.discovery import Discovery
from exo.networking.peer_handle import PeerHandle
from exo.topology.device_capabilities import DeviceCapabilities, device_capabilities, UNKNOWN_DEVICE_CAPABILITIES
from exo.helpers import DEBUG, DEBUG_DISCOVERY
from .tailscale_helpers import get_tailscale_devices_local, get_tailscale_devices, Device


class TailscaleDiscovery(Discovery):
  def __init__(
    self,
    node_id: str,
    node_port: int,
    create_peer_handle: Callable[[str, str, str, DeviceCapabilities], PeerHandle],
    discovery_interval: int = 5,
    discovery_timeout: int = 30,
    device_capabilities: DeviceCapabilities = UNKNOWN_DEVICE_CAPABILITIES,
    tailscale_api_key: str = None,
    tailnet: str = None,
    allowed_node_ids: List[str] = None,
    default_peer_port: Optional[int] = None,
  ):
    self.node_id = node_id
    self.node_port = node_port
    self.create_peer_handle = create_peer_handle
    self.discovery_interval = discovery_interval
    self.discovery_timeout = discovery_timeout
    self.device_capabilities = device_capabilities
    self.known_peers: Dict[str, Tuple[PeerHandle, float, float]] = {}
    self.discovery_task = None
    self.cleanup_task = None
    self.tailscale_api_key = tailscale_api_key
    self.tailnet = tailnet
    self.allowed_node_ids = allowed_node_ids
    self.default_peer_port = default_peer_port or node_port
    self.use_local_discovery = not (tailscale_api_key and tailnet)

  async def start(self):
    self.device_capabilities = await device_capabilities()

    if self.use_local_discovery:
      if DEBUG >= 1:
        print("[Tailscale] 🚀 Using LOCAL auto-discovery (no API key needed!)")
      print("[Tailscale] ✅ Both nodes just need to join the same Tailscale network")
    else:
      if DEBUG >= 1:
        print(f"[Tailscale] 🔑 Using API discovery (tailnet: {self.tailnet})")

    self.discovery_task = asyncio.create_task(self.task_discover_peers())
    self.cleanup_task = asyncio.create_task(self.task_cleanup_peers())

  async def _discover_devices(self) -> Dict[str, Device]:
    """Discover devices using local CLI (preferred) or API (fallback)"""
    try:
      # Method 1: Local CLI discovery (automatic, no API key)
      if self.use_local_discovery:
        devices, _ = await get_tailscale_devices_local()
        return devices

      # Method 2: API-based discovery (fallback)
      devices = await get_tailscale_devices(self.tailscale_api_key, self.tailnet)
      return devices

    except Exception as e:
      print(f"[Tailscale] ❌ Discovery failed: {e}")
      return {}

  async def task_discover_peers(self):
    while True:
      try:
        devices: dict[str, Device] = await self._discover_devices()

        if not devices:
          if DEBUG_DISCOVERY >= 2:
            print("[Tailscale] No devices found. Waiting for peers to join Tailscale...")
          await asyncio.sleep(self.discovery_interval)
          continue

        current_time = time.time()
        print(f"[Tailscale] 🔄 Discovery cycle: {len(devices)} device(s) found, Self={self.node_id}")

        for device_name, device in devices.items():
          print(f"[Tailscale] 📝 Processing: {device_name} (name={device.name}, addr={device.addresses})")

          # Skip self
          if device_name == self.node_id or device.name == self.node_id:
            print(f"[Tailscale] ⏭️ Skipping self: {device_name} == {self.node_id}")
            continue

          peer_host = device.addresses[0] if device.addresses else None
          if not peer_host:
            print(f"[Tailscale] ❌ No address for {device_name}. Skip.")
            continue

          peer_id = device_name

          # Filter by allowed list (if specified)
          if self.allowed_node_ids and peer_id not in self.allowed_node_ids:
            print(f"[Tailscale] ❌ {peer_id} not in allowed list: {self.allowed_node_ids}")
            continue

          peer_addr = f"{peer_host}:{self.default_peer_port}"
          print(f"[Tailscale] 🔗 Attempting to connect: {peer_id} @ {peer_addr}")

          # New peer or address changed
          if peer_id not in self.known_peers or self.known_peers[peer_id][0].addr() != peer_addr:
            try:
              new_peer_handle = self.create_peer_handle(peer_id, peer_addr, "TS", UNKNOWN_DEVICE_CAPABILITIES)

              # Health check to verify it's an exo node
              print(f"[Tailscale] 💓 Health check for {peer_id}...")
              is_healthy = await new_peer_handle.health_check()
              print(f"[Tailscale] {'✅' if is_healthy else '❌'} Health check result: {is_healthy}")

              if not is_healthy:
                print(f"[Tailscale] ⚠️ Peer {peer_id} at {peer_addr} is not an exo node (health check failed)")
                continue

              if DEBUG >= 1:
                print(f"[Tailscale] ✅ Discovered exo node: {peer_id} at {peer_addr}")

              self.known_peers[peer_id] = (
                new_peer_handle,
                current_time,
                current_time,
              )
            except Exception as e:
              print(f"[Tailscale] ❌ Error connecting to {peer_id}: {type(e).__name__}: {e}")
              continue
          else:
            # Existing peer - health check
            try:
              is_healthy = await self.known_peers[peer_id][0].health_check()
              if not is_healthy:
                if DEBUG >= 1:
                  print(f"[Tailscale] ❌ Peer {peer_id} became unhealthy. Removing.")
                if peer_id in self.known_peers:
                  del self.known_peers[peer_id]
                continue

              # Update last seen timestamp
              self.known_peers[peer_id] = (
                self.known_peers[peer_id][0],
                self.known_peers[peer_id][1],
                current_time
              )
            except Exception as e:
              print(f"[Tailscale] ❌ Error checking existing peer {peer_id}: {e}")
              continue

        print(f"[Tailscale] ✅ Discovery cycle complete. Known peers: {list(self.known_peers.keys())}")

      except Exception as e:
        print(f"[Tailscale] ❌ Error in discover peers: {e}")
        import traceback
        if DEBUG_DISCOVERY >= 2:
          print(traceback.format_exc())
      finally:
        await asyncio.sleep(self.discovery_interval)

  async def stop(self):
    if self.discovery_task:
      self.discovery_task.cancel()
    if self.cleanup_task:
      self.cleanup_task.cancel()
    if self.discovery_task or self.cleanup_task:
      await asyncio.gather(self.discovery_task, self.cleanup_task, return_exceptions=True)

  async def discover_peers(self, wait_for_peers: int = 0) -> List[PeerHandle]:
    if wait_for_peers > 0:
      while len(self.known_peers) < wait_for_peers:
        if DEBUG_DISCOVERY >= 2:
          print(f"[Tailscale] Current peers: {len(self.known_peers)}/{wait_for_peers}. Waiting...")
        await asyncio.sleep(0.1)
    return [peer_handle for peer_handle, _, _ in self.known_peers.values()]

  async def task_cleanup_peers(self):
    while True:
      try:
        current_time = time.time()
        peers_to_remove = []

        peer_ids = list(self.known_peers.keys())
        results = await asyncio.gather(
          *[self.check_peer(peer_id, current_time) for peer_id in peer_ids],
          return_exceptions=True
        )

        for peer_id, should_remove in zip(peer_ids, results):
          if should_remove:
            peers_to_remove.append(peer_id)

        if DEBUG_DISCOVERY >= 2:
          statuses = {}
          for peer_handle, connected_at, last_seen in self.known_peers.values():
            is_conn = await peer_handle.is_connected()
            health = await peer_handle.health_check()
            statuses[peer_handle.id()] = f"connected={is_conn}, healthy={health}"
          print(f"[Tailscale] Peer statuses: {statuses}")

        for peer_id in peers_to_remove:
          if peer_id in self.known_peers:
            del self.known_peers[peer_id]
            if DEBUG_DISCOVERY >= 2:
              print(f"[Tailscale] Removed inactive peer: {peer_id}")

      except Exception as e:
        print(f"[Tailscale] Error in cleanup: {e}")
        if DEBUG_DISCOVERY >= 2:
          print(traceback.format_exc())
      finally:
        await asyncio.sleep(self.discovery_interval)

  async def check_peer(self, peer_id: str, current_time: float) -> bool:
    peer_handle, connected_at, last_seen = self.known_peers.get(peer_id, (None, None, None))
    if peer_handle is None:
      return False

    try:
      is_connected = await peer_handle.is_connected()
      health_ok = await peer_handle.health_check()
    except Exception as e:
      if DEBUG_DISCOVERY >= 2:
        print(f"[Tailscale] Error checking peer {peer_id}: {e}")
      return True  # Don't remove on transient errors

    should_remove = (
      (not is_connected and current_time - connected_at > self.discovery_timeout) or
      (not health_ok and current_time - last_seen > self.discovery_timeout)
    )
    return should_remove
