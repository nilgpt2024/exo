import os
import json
from pathlib import Path
from typing import Dict, Any, Optional

try:
    import toml
    HAS_TOML = True
except ImportError:
    HAS_TOML = False


class FRPConfig:
    """frp 配置管理器"""
    
    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or Path.home() / ".exo" / "frp"
        self.config_dir.mkdir(parents=True, exist_ok=True)
    
    def get_frpc_config_path(self, node_id: str) -> Path:
        """获取 frpc 配置文件路径"""
        if HAS_TOML:
            return self.config_dir / f"frpc_{node_id}.toml"
        else:
            return self.config_dir / f"frpc_{node_id}.ini"
    
    def get_frps_config_path(self) -> Path:
        """获取 frps 配置文件路径"""
        if HAS_TOML:
            return self.config_dir / "frps.toml"
        else:
            return self.config_dir / "frps.ini"
    
    def generate_frps_config(
        self,
        bind_port: int = 7000,
        vhost_http_port: Optional[int] = None,
        vhost_https_port: Optional[int] = None,
        dashboard_port: Optional[int] = None,
        dashboard_user: Optional[str] = None,
        dashboard_pwd: Optional[str] = None,
        token: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """生成 frps 服务端配置"""
        config = {
            "bindPort": bind_port,
        }
        
        if vhost_http_port:
            config["vhostHTTPPort"] = vhost_http_port
        if vhost_https_port:
            config["vhostHTTPSPort"] = vhost_https_port
        if dashboard_port:
            config["webServer"] = {
                "addr": "0.0.0.0",
                "port": dashboard_port,
            }
            if dashboard_user:
                config["webServer"]["user"] = dashboard_user
            if dashboard_pwd:
                config["webServer"]["password"] = dashboard_pwd
        if token:
            config["auth"] = {
                "token": token
            }
        
        return config
    
    def generate_frpc_config(
        self,
        server_addr: str,
        server_port: int,
        node_id: str,
        local_port: int,
        remote_port: Optional[int] = None,
        token: Optional[str] = None,
        enable_p2p: bool = True,
        **kwargs
    ) -> Dict[str, Any]:
        """生成 frpc 客户端配置（同时支持 TCP 中转和 XTCP P2P）"""
        # 如果未指定远程端口，自动生成一个
        if remote_port is None:
            # 使用 node_id 的哈希值生成端口，范围 30000-50000
            import hashlib
            hash_val = int(hashlib.md5(node_id.encode()).hexdigest()[:8], 16)
            remote_port = 30000 + (hash_val % 20000)
        
        # 生成 secret key（基于 node_id）
        import hashlib
        secret_key = hashlib.sha256(node_id.encode()).hexdigest()[:16]
        
        config = {
            "serverAddr": server_addr,
            "serverPort": server_port,
            "proxies": []
        }
        
        # 添加 TCP 代理（作为备用方案）
        config["proxies"].append({
            "name": f"exo_tcp_{node_id}",
            "type": "tcp",
            "localIP": "127.0.0.1",
            "localPort": local_port,
            "remotePort": remote_port,
        })
        
        # 如果启用 P2P，添加 XTCP 代理
        if enable_p2p:
            config["proxies"].append({
                "name": f"exo_xtcp_{node_id}",
                "type": "xtcp",
                "secretKey": secret_key,
                "localIP": "127.0.0.1",
                "localPort": local_port,
            })
        
        if token:
            config["auth"] = {
                "token": token
            }
        
        return config
    
    def save_config(self, config: Dict[str, Any], config_path: Path) -> bool:
        """保存配置到文件"""
        try:
            if HAS_TOML:
                with open(config_path, "w", encoding="utf-8") as f:
                    toml.dump(config, f)
                print(f"配置已保存: {config_path}")
            else:
                ini_content = self._dict_to_ini(config)
                with open(config_path, "w", encoding="utf-8") as f:
                    f.write(ini_content)
                print(f"配置已保存 (INI 格式): {config_path}")
            return True
        except Exception as e:
            print(f"保存配置失败: {e}")
            return False
    
    def _dict_to_ini(self, config: Dict[str, Any]) -> str:
        """将字典转换为 TOML 格式字符串"""
        lines = []
        
        if "serverAddr" in config:
            lines.append(f"serverAddr = \"{config['serverAddr']}\"")
        if "serverPort" in config:
            lines.append(f"serverPort = {config['serverPort']}")
        
        if "auth" in config:
            if "token" in config["auth"]:
                lines.append(f"auth.token = \"{config['auth']['token']}\"")
        
        if "proxies" in config:
            for proxy in config["proxies"]:
                lines.append("")
                lines.append(f"[[proxies]]")
                if "name" in proxy:
                    lines.append(f"name = \"{proxy['name']}\"")
                if "type" in proxy:
                    lines.append(f"type = \"{proxy['type']}\"")
                if "localIP" in proxy:
                    lines.append(f"localIP = \"{proxy['localIP']}\"")
                if "localPort" in proxy:
                    lines.append(f"localPort = {proxy['localPort']}")
                if "remotePort" in proxy:
                    lines.append(f"remotePort = {proxy['remotePort']}")
                if "secretKey" in proxy:
                    lines.append(f"secretKey = \"{proxy['secretKey']}\"")
        
        return "\n".join(lines) + "\n"
    
    def load_config(self, config_path: Path) -> Optional[Dict[str, Any]]:
        """从文件加载配置"""
        try:
            if not config_path.exists():
                print(f"配置文件不存在: {config_path}")
                return None
            
            if HAS_TOML and str(config_path).endswith(".toml"):
                with open(config_path, "r", encoding="utf-8") as f:
                    return toml.load(f)
            elif str(config_path).endswith(".ini"):
                return self._ini_to_dict(config_path)
            else:
                with open(config_path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as e:
            print(f"加载配置失败: {e}")
            return None
    
    def _ini_to_dict(self, config_path: Path) -> Dict[str, Any]:
        """从 INI 文件加载配置"""
        config = {}
        current_section = None
        
        with open(config_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                
                if line.startswith("[["):
                    if "proxies" not in config:
                        config["proxies"] = []
                    config["proxies"].append({})
                    current_section = "proxies"
                elif line.startswith("[") and line.endswith("]"):
                    section_name = line[1:-1]
                    config[section_name] = {}
                    current_section = section_name
                elif "=" in line:
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip()
                    
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    elif value.isdigit():
                        value = int(value)
                    
                    if current_section == "proxies":
                        config["proxies"][-1][key] = value
                    elif current_section:
                        config[current_section][key] = value
                    else:
                        config[key] = value
        
        return config
    
    def save_frps_config(self, config: Dict[str, Any]) -> bool:
        """保存 frps 配置"""
        return self.save_config(config, self.get_frps_config_path())
    
    def save_frpc_config(self, config: Dict[str, Any], node_id: str) -> bool:
        """保存 frpc 配置"""
        self._cleanup_old_config_files(node_id)
        return self.save_config(config, self.get_frpc_config_path(node_id))
    
    def _cleanup_old_config_files(self, node_id: str):
        """清理旧格式的配置文件"""
        for ext in ['.toml', '.json', '.ini']:
            old_file = self.config_dir / f"frpc_{node_id}{ext}"
            if old_file.exists():
                try:
                    old_file.unlink()
                    print(f"[FRP] 已清理旧配置文件: {old_file}")
                except Exception as e:
                    print(f"[FRP] 清理旧配置文件失败: {e}")
