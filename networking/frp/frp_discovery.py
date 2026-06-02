import os
import asyncio
import json
import hashlib
import logging
from typing import Dict, List, Callable, Optional, Set
from pathlib import Path

from exo.networking.discovery import Discovery
from exo.topology.device_capabilities import DeviceCapabilities, UNKNOWN_DEVICE_CAPABILITIES
from exo.networking.peer_handle import PeerHandle
from exo.helpers import DEBUG_DISCOVERY
from exo.networking.frp.frp_downloader import ensure_frpc_installed, get_frpc_path
from exo.networking.frp.frp_config import FRPConfig
from exo.networking.frp.frp_process import FRPProcessManager


def calculate_remote_port(node_id: str) -> int:
    """根据 node_id 计算远程端口（与 frp_config.py 中的逻辑一致）"""
    hash_val = int(hashlib.md5(node_id.encode()).hexdigest()[:8], 16)
    return 30000 + (hash_val % 20000)


class NodeInfo:
    """节点信息"""
    def __init__(
        self,
        node_id: str,
        address: str,
        port: int,
        description: str = "FRP",
        device_capabilities: Optional[DeviceCapabilities] = None
    ):
        self.node_id = node_id
        self.address = address
        self.port = port
        self.description = description
        self.device_capabilities = device_capabilities or UNKNOWN_DEVICE_CAPABILITIES
    
    def to_dict(self) -> Dict:
        return {
            "node_id": self.node_id,
            "address": self.address,
            "port": self.port,
            "description": self.description,
            "device_capabilities": {
                "model": self.device_capabilities.model,
                "chip": self.device_capabilities.chip,
                "memory": self.device_capabilities.memory
            }
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "NodeInfo":
        dc = data.get("device_capabilities", {})
        return cls(
            node_id=data["node_id"],
            address=data["address"],
            port=data["port"],
            description=data.get("description", "FRP"),
            device_capabilities=DeviceCapabilities(
                model=dc.get("model", "unknown"),
                chip=dc.get("chip", "unknown"),
                memory=dc.get("memory", 0)
            )
        )


class FRPDiscovery(Discovery):
    """基于 frp 的跨公网节点发现 - 支持自动发现和种子节点"""

    def __init__(
        self,
        frp_server_addr: str,
        frp_server_port: int,
        node_id: str,
        local_port: int,
        create_peer_handle: Callable[[str, str, str, DeviceCapabilities], PeerHandle],
        frp_token: Optional[str] = None,
        frp_remote_port: Optional[int] = None,
        seed_peers: Optional[str] = None,
        discovery_timeout: int = 30,
        device_capabilities: Optional[DeviceCapabilities] = None,
        enable_p2p: bool = False,
    ):
        """
        初始化 FRPDiscovery
        
        Args:
            frp_server_addr: frp 服务器地址
            frp_server_port: frp 服务器端口
            node_id: 本节点 ID
            local_port: 本节点本地服务端口
            create_peer_handle: 创建 PeerHandle 的回调函数
            frp_token: frp 认证 token（可选）
            frp_remote_port: frp 远程端口（可选，不指定则自动生成）
            seed_peers: 种子节点列表，格式："node1@addr:port,node2@addr:port"（可选）
            discovery_timeout: 发现超时时间（秒）
            device_capabilities: 本节点的设备能力信息
            enable_p2p: 是否启用 P2P（xtcp）模式（默认 False，使用 TCP 中转模式更稳定）
        """
        self.frp_server_addr = frp_server_addr
        self.frp_server_port = frp_server_port
        self.node_id = node_id
        self.local_port = local_port
        self.create_peer_handle = create_peer_handle
        self.frp_token = frp_token
        self.frp_remote_port = frp_remote_port
        self.discovery_timeout = discovery_timeout
        self.device_capabilities = device_capabilities or DeviceCapabilities("unknown", "unknown", 0)
        self.enable_p2p = enable_p2p

        self.listen_task = None
        self.known_peers: Dict[str, PeerHandle] = {}
        self.known_node_infos: Dict[str, NodeInfo] = {}
        
        self.frp_config = FRPConfig()
        self.frp_process_manager: Optional[FRPProcessManager] = None
        self.my_remote_port: Optional[int] = None
        self.my_address: Optional[str] = None
        
        # 解析种子节点
        self.seed_node_infos: List[NodeInfo] = self._parse_seed_peers(seed_peers)

    def _parse_seed_peers(self, seed_peers: Optional[str]) -> List[NodeInfo]:
        """解析种子节点字符串"""
        if not seed_peers:
            return []
        
        result = []
        for peer_str in seed_peers.split(","):
            peer_str = peer_str.strip()
            if not peer_str:
                continue
            
            try:
                # 格式: node_id@address:port
                if "@" in peer_str:
                    node_id_part, addr_part = peer_str.split("@", 1)
                    node_id = node_id_part.strip()
                else:
                    node_id = f"seed_{len(result)}"
                    addr_part = peer_str
                
                if ":" in addr_part:
                    address, port_str = addr_part.rsplit(":", 1)
                    port = int(port_str)
                else:
                    address = addr_part
                    port = 5678
                
                result.append(NodeInfo(node_id, address, port))
                print(f"[FRP] 添加种子节点: {node_id} @ {address}:{port}")
            except Exception as e:
                print(f"[FRP] 解析种子节点失败: {peer_str}, 错误: {e}")
        
        return result

    async def start(self) -> None:
        """启动 frp 发现"""
        print("=" * 60)
        print("  启动 FRP 发现模块 (自动发现模式)")
        print("=" * 60)
        print(f"[FRP] 节点 ID: {self.node_id}")
        
        # 1. 确保 frpc 已安装
        if not ensure_frpc_installed():
            print("[FRP] 错误: 无法安装或找到 frpc")
            return
        
        # 2. 生成并保存 frpc 配置
        frpc_config = self.frp_config.generate_frpc_config(
            server_addr=self.frp_server_addr,
            server_port=self.frp_server_port,
            node_id=self.node_id,
            local_port=self.local_port,
            remote_port=self.frp_remote_port,
            token=self.frp_token,
            enable_p2p=self.enable_p2p
        )
        
        # 获取分配的远程端口
        if frpc_config and "proxies" in frpc_config and len(frpc_config["proxies"]) > 0:
            self.my_remote_port = frpc_config["proxies"][0].get("remotePort")
            self.my_address = self.frp_server_addr
            print(f"[FRP] 本节点访问地址: {self.my_address}:{self.my_remote_port}")
        
        config_path = self.frp_config.get_frpc_config_path(self.node_id)
        self.frp_config.save_frpc_config(frpc_config, self.node_id)
        
        # 3. 启动 frpc 进程
        frpc_path = get_frpc_path()
        self.frp_process_manager = FRPProcessManager(frpc_path, config_path)
        self.frp_process_manager.start()
        
        # 4. 添加种子节点到已知节点列表
        for seed_info in self.seed_node_infos:
            if seed_info.node_id != self.node_id:
                self.known_node_infos[seed_info.node_id] = seed_info
        
        # 5. 启动发现任务
        self.listen_task = asyncio.create_task(self._discovery_loop())
        
        logging.info(f"[FRP start] Discovery loop task created: {self.listen_task}")
        print("[FRP] FRP 发现模块启动成功")
        print()

    async def stop(self) -> None:
        """停止 frp 发现"""
        if self.listen_task:
            self.listen_task.cancel()
        
        if self.frp_process_manager:
            self.frp_process_manager.stop()

    async def discover_peers(self, wait_for_peers: int = 0) -> List[PeerHandle]:
        """发现对等节点"""
        logging.info(f"[FRP discover_peers] Called, known_peers={[p.id() for p in self.known_peers.values()]}")
        
        if not self.known_peers and self.known_node_infos:
            logging.info(f"[FRP discover_peers] known_peers is empty but known_node_infos has {len(self.known_node_infos)} nodes, waiting for health check...")
            max_wait = 5.0
            wait_interval = 0.1
            waited = 0.0
            while not self.known_peers and waited < max_wait:
                await asyncio.sleep(wait_interval)
                waited += wait_interval
                if waited >= 1.0 and int(waited) % 2 == 0:
                    logging.info(f"[FRP discover_peers] Still waiting for health check... ({waited:.1f}s)")
            
            if self.known_peers:
                logging.info(f"[FRP discover_peers] Health check completed, found {len(self.known_peers)} peers")
            else:
                logging.warning(f"[FRP discover_peers] Health check timeout after {max_wait}s, no peers found")
        
        if wait_for_peers > 0:
            while len(self.known_peers) < wait_for_peers:
                if DEBUG_DISCOVERY >= 2:
                    print(f"[FRP] 当前对等节点: {len(self.known_peers)}/{wait_for_peers}. 等待更多节点...")
                await asyncio.sleep(0.1)
        
        if DEBUG_DISCOVERY >= 2:
            print(f"[FRP] 发现的对等节点: {[peer.id() for peer in self.known_peers.values()]}")
        
        result = list(self.known_peers.values())
        logging.info(f"[FRP discover_peers] Returning {len(result)} peers: {[p.id() for p in result]}")
        return result

    def add_known_node(self, node_id: str, address: str, port: int, 
                       description: str = "Connected", 
                       device_capabilities: Optional[DeviceCapabilities] = None) -> bool:
        """
        添加已知节点（被动接收连接时调用）
        
        Args:
            node_id: 节点 ID
            address: 节点地址
            port: 节点端口
            description: 描述
            device_capabilities: 设备能力
            
        Returns:
            是否成功添加（如果已存在或是自己则返回 False）
        """
        logging.info(f"[FRP add_known_node] Called with node_id={node_id}, address={address}:{port}, self.node_id={self.node_id}")
        if node_id == self.node_id:
            logging.info(f"[FRP add_known_node] Skipping self node")
            return False
            
        if node_id in self.known_node_infos:
            logging.info(f"[FRP add_known_node] Node already known: {node_id}")
            return False
        
        node_info = NodeInfo(
            node_id=node_id,
            address=address,
            port=port,
            description=description,
            device_capabilities=device_capabilities or UNKNOWN_DEVICE_CAPABILITIES
        )
        self.known_node_infos[node_id] = node_info
        logging.info(f"[FRP add_known_node] Added new node to discovery list: {node_id} @ {address}:{port}")
        print(f"[FRP] 添加新节点到发现列表: {node_id} @ {address}:{port}")
        return True

    def get_my_address_info(self) -> Optional[Dict[str, any]]:
        """获取本节点的 FRP 地址信息"""
        if self.my_address and self.my_remote_port:
            return {
                "address": self.my_address,
                "port": self.my_remote_port
            }
        return None

    async def _discovery_loop(self):
        """发现循环"""
        logging.info("[FRP _discovery_loop] Starting automatic node discovery...")
        print("[FRP] 开始自动节点发现...")
        
        await asyncio.sleep(3)
        
        last_online_peers = set()
        
        while True:
            try:
                logging.info(f"[FRP _discovery_loop] known_node_infos count: {len(self.known_node_infos)}, nodes: {list(self.known_node_infos.keys())}")
                if self.known_node_infos:
                    if DEBUG_DISCOVERY:
                        print(f"[FRP] 正在检查 {len(self.known_node_infos)} 个已知节点...")
                    
                    health_check_tasks = [
                        self._check_and_update_node(node_info)
                        for node_info in self.known_node_infos.values()
                        if node_info.node_id != self.node_id
                    ]
                    
                    if health_check_tasks:
                        results = await asyncio.gather(*health_check_tasks, return_exceptions=True)
                        
                        new_known_peers = {}
                        for result in results:
                            if isinstance(result, PeerHandle):
                                new_known_peers[result.id()] = result
                        
                        logging.info(f"[FRP _discovery_loop] Health check results: {len(new_known_peers)} healthy peers")
                        
                        new_peers = set(new_known_peers.keys()) - set(self.known_peers.keys())
                        if new_peers:
                            print(f"[FRP] 新节点上线: {new_peers}")
                        
                        removed_peers = set(self.known_peers.keys()) - set(new_known_peers.keys())
                        if removed_peers:
                            print(f"[FRP] 节点下线: {removed_peers}")
                            logging.warning(f"[FRP _discovery_loop] Peers removed due to failed health check: {removed_peers}")
                        
                        self.known_peers = new_known_peers
                    
                    current_online = set(self.known_peers.keys())
                    if current_online != last_online_peers:
                        print(f"[FRP] 当前在线节点: {list(self.known_peers.keys())}")
                        last_online_peers = current_online
                else:
                    logging.info("[FRP _discovery_loop] No known nodes, waiting for discovery...")
                    if DEBUG_DISCOVERY:
                        print("[FRP] 没有已知节点，等待发现...")
                
            except Exception as e:
                logging.error(f"[FRP _discovery_loop] Error in discovery loop: {e}")
                print(f"[FRP] 发现循环出错: {e}")
                import traceback
                traceback.print_exc()
            
            await asyncio.sleep(5)

    async def _check_and_update_node(self, node_info: NodeInfo) -> Optional[PeerHandle]:
        """检查节点健康状态，并尝试获取该节点知道的其他节点"""
        try:
            peer = self.known_peers.get(node_info.node_id)
            is_reconnect = False
            if not peer:
                print(f"[FRP] 尝试连接节点: {node_info.node_id} @ {node_info.address}:{node_info.port}")
                peer = self.create_peer_handle(
                    node_info.node_id,
                    f"{node_info.address}:{node_info.port}",
                    node_info.description,
                    node_info.device_capabilities
                )
                is_reconnect = True
            
            logging.info(f"[FRP _check_and_update_node] Checking health for {node_info.node_id}")
            is_healthy = await asyncio.wait_for(peer.health_check(), timeout=30.0)
            logging.info(f"[FRP _check_and_update_node] Health check result for {node_info.node_id}: {is_healthy}")
            
            if is_healthy:
                actual_node_id = peer.id()
                if actual_node_id == self.node_id:
                    print(f"[FRP] 检测到自身节点，跳过: {node_info.node_id}")
                    if node_info.node_id in self.known_node_infos:
                        del self.known_node_infos[node_info.node_id]
                    return None
                
                if is_reconnect or DEBUG_DISCOVERY:
                    print(f"[FRP] 节点连接成功: {actual_node_id} (配置ID: {node_info.node_id})")
                
                try:
                    topology = await asyncio.wait_for(
                        peer.collect_topology(visited=set(), max_depth=2),
                        timeout=5.0
                    )
                    
                    new_nodes_found = 0
                    for node_id, capabilities in topology.nodes.items():
                        if node_id != self.node_id and node_id not in self.known_node_infos:
                            remote_port = calculate_remote_port(node_id)
                            
                            new_node_info = NodeInfo(
                                node_id=node_id,
                                address=self.frp_server_addr,
                                port=remote_port,
                                description="Auto-discovered",
                                device_capabilities=capabilities
                            )
                            self.known_node_infos[node_id] = new_node_info
                            new_nodes_found += 1
                            print(f"[FRP] 发现新节点: {node_id} @ {self.frp_server_addr}:{remote_port}")
                    
                    if new_nodes_found > 0:
                        print(f"[FRP] 从 {node_info.node_id} 发现 {new_nodes_found} 个新节点")
                        
                except Exception as e:
                    print(f"[FRP] 从 {node_info.node_id} 获取拓扑信息失败: {e}")
                
                return peer
            else:
                print(f"[FRP] 节点不健康: {node_info.node_id}")
                return None
                
        except asyncio.TimeoutError:
            print(f"[FRP] 连接超时: {node_info.node_id} @ {node_info.address}:{node_info.port}")
            logging.warning(f"[FRP _check_and_update_node] Timeout checking {node_info.node_id}")
            return None
        except Exception as e:
            print(f"[FRP] 连接失败: {node_info.node_id}, 错误: {e}")
            logging.error(f"[FRP _check_and_update_node] Failed to check {node_info.node_id}: {e}")
            return None
