import grpc
import numpy as np
import asyncio
from typing import Optional, Tuple, List
import traceback

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import node_service_pb2
import node_service_pb2_grpc

from ..peer_handle import PeerHandle
from exo.inference.shard import Shard
from exo.topology.topology import Topology
from exo.topology.device_capabilities import DeviceCapabilities, DeviceFlops
from exo.helpers import DEBUG
import json
import platform

if platform.system().lower() == "darwin" and platform.machine().lower() == "arm64":
  import mlx.core as mx
else:
  import numpy as mx


class GRPCPeerHandle(PeerHandle):
  def __init__(self, _id: str, address: str, desc: str, device_capabilities: DeviceCapabilities):
    self._id = _id
    self.address = address
    self.desc = desc
    self._device_capabilities = device_capabilities
    self.channel = None
    self.stub = None
    self.channel_options = [
      ("grpc.max_metadata_size", 32 * 1024 * 1024),
      ("grpc.max_receive_message_length", 256 * 1024 * 1024),
      ("grpc.max_send_message_length", 256 * 1024 * 1024),
      ("grpc.max_concurrent_streams", 100),
      ("grpc.http2.min_time_between_pings_ms", 10000),
      ("grpc.keepalive_time_ms", 10000),
      ("grpc.keepalive_timeout_ms", 60000),  # 增加到60秒，适应慢速网络
      ("grpc.keepalive_permit_without_calls", 1),
      ("grpc.http2.max_pings_without_data", 0),
      ("grpc.http2.min_ping_interval_without_data_ms", 5000),
      ("grpc.tcp_nodelay", 1),
      ("grpc.optimization_target", "throughput"),
    ]

  def id(self) -> str:
    return self._id

  def addr(self) -> str:
    return self.address

  def description(self) -> str:
    return self.desc

  def device_capabilities(self) -> DeviceCapabilities:
    return self._device_capabilities

  async def connect(self):
    self.channel = grpc.aio.insecure_channel(
      self.address,
      options=self.channel_options,
      compression=grpc.Compression.Gzip
    )
    self.stub = node_service_pb2_grpc.NodeServiceStub(self.channel)
    await asyncio.wait_for(self.channel.channel_ready(), timeout=30.0)

  async def is_connected(self) -> bool:
    return self.channel is not None and self.channel.get_state() == grpc.ChannelConnectivity.READY

  async def disconnect(self):
    if self.channel:
      await self.channel.close()
    self.channel = None
    self.stub = None

  async def _ensure_connected(self):
    if not (await self.is_connected()):
      try:
        await asyncio.wait_for(self.connect(), timeout=60.0)  # 增加到60秒，适应高延迟网络（DERP中继）
      except asyncio.TimeoutError:
        if DEBUG >= 2: print(f"Connection timeout for {self._id}@{self.address}")
        await self.disconnect()
        raise

  async def health_check(self, timeout=60) -> bool:
    try:
      await self._ensure_connected()
      request = node_service_pb2.HealthCheckRequest()
      response = await asyncio.wait_for(self.stub.HealthCheck(request), timeout=timeout)
      return response.is_healthy
    except asyncio.TimeoutError:
      print(f"[HealthCheck] ⏰ Timeout for {self._id}@{self.address} ({timeout}s limit)")
      return False
    except grpc.aio.AioRpcError as e:
      print(f"[HealthCheck] ❌ gRPC error for {self._id}@{self.address}: code={e.code()}, details={e.details()}")
      return False
    except Exception as e:
      print(f"[HealthCheck] ❌ Error for {self._id}@{self.address}: {type(e).__name__}: {e}")
      if DEBUG >= 4:
        import traceback
        traceback.print_exc()
      return False

  async def send_prompt(self, shard: Shard, prompt: str, inference_state: Optional[dict] = None, request_id: Optional[str] = None) -> Optional[np.array]:
    await self._ensure_connected()
    request = node_service_pb2.PromptRequest(
      prompt=prompt,
      shard=node_service_pb2.Shard(
        model_id=shard.model_id,
        start_layer=shard.start_layer,
        end_layer=shard.end_layer,
        n_layers=shard.n_layers,
      ),
      request_id=request_id,
      inference_state=None if inference_state is None else self.serialize_inference_state(inference_state)
    )
    await self.stub.SendPrompt(request)

  async def send_tensor(self, shard: Shard, tensor: np.ndarray, inference_state: Optional[dict] = None, request_id: Optional[str] = None) -> Optional[np.array]:
    await self._ensure_connected()
    print(f"[DEBUG send_tensor] Sending tensor: shape={tensor.shape}, dtype={tensor.dtype}, nbytes={tensor.nbytes}")
    shape_list = list(tensor.shape)
    print(f"[DEBUG send_tensor] shape_list: {shape_list}")
    request = node_service_pb2.TensorRequest(
      shard=node_service_pb2.Shard(
        model_id=shard.model_id,
        start_layer=shard.start_layer,
        end_layer=shard.end_layer,
        n_layers=shard.n_layers,
      ),
      tensor=node_service_pb2.Tensor(tensor_data=tensor.tobytes(), shape=shape_list, dtype=str(tensor.dtype)),
      request_id=request_id,
      inference_state=None if inference_state is None else self.serialize_inference_state(inference_state)
    )
    print(f"[DEBUG send_tensor] request.tensor.shape: {request.tensor.shape}")
    response = await asyncio.wait_for(self.stub.SendTensor(request), timeout=120.0)  # 2分钟超时

    if not response.tensor_data or not response.shape or not response.dtype:
      return None

    result = np.frombuffer(response.tensor_data, dtype=np.dtype(response.dtype)).reshape(response.shape)
    print(f"[DEBUG send_tensor] Received response: shape={result.shape}, dtype={result.dtype}")
    return result

  async def send_example(self, shard: Shard, example: np.ndarray, target: np.ndarray, length: np.ndarray, train: bool, request_id: Optional[str] = None) -> Optional[np.array]:
    await self._ensure_connected()
    request = node_service_pb2.ExampleRequest(
      shard=node_service_pb2.Shard(
        model_id=shard.model_id,
        start_layer=shard.start_layer,
        end_layer=shard.end_layer,
        n_layers=shard.n_layers,
      ),
      example=node_service_pb2.Tensor(tensor_data=example.tobytes(), shape=example.shape, dtype=str(example.dtype)),
      target=node_service_pb2.Tensor(tensor_data=target.tobytes(), shape=target.shape, dtype=str(target.dtype)),
      length=node_service_pb2.Tensor(tensor_data=length.tobytes(), shape=length.shape, dtype=str(length.dtype)),
      train=train,
      request_id=request_id,
    )
    response = await self.stub.SendExample(request)
    loss = response.loss
    if train and not shard.is_first_layer():
      grads = np.frombuffer(response.grads.tensor_data, dtype=np.dtype(response.grads.dtype)).reshape(response.grads.shape)
      return loss, grads
    else:
      return loss

  async def send_loss(self, shard: Shard, tensor: np.ndarray, request_id: Optional[str] = None) -> Optional[np.array]:
    await self._ensure_connected()
    request = node_service_pb2.TensorRequest(
      shard=node_service_pb2.Shard(
        model_id=shard.model_id,
        start_layer=shard.start_layer,
        end_layer=shard.end_layer,
        n_layers=shard.n_layers,
      ),
      tensor=node_service_pb2.Tensor(tensor_data=tensor.tobytes(), shape=tensor.shape, dtype=str(tensor.dtype)),
      request_id=request_id,
    )
    response = await self.stub.SendLoss(request)

    if not response.tensor_data or not response.shape or not response.dtype:
      return None

    return np.frombuffer(response.tensor_data, dtype=np.dtype(response.dtype)).reshape(response.shape)

  async def collect_topology(self, visited: set[str], max_depth: int = 4) -> Topology:
    """Collect topology information from this peer"""
    if DEBUG >= 2: print(f"[GRPC] Collecting topology from {self.id()} (max_depth={max_depth}, visited={visited})")
    
    try:
      request = node_service_pb2.CollectTopologyRequest(
        visited=list(visited),
        max_depth=max_depth
      )
      
      response = await self.stub.CollectTopology(request)
      topology = Topology()
      
      for node_id, device_capabilities in response.nodes.items():
        from exo.topology.device_capabilities import DeviceCapabilities, DeviceFlops, DeviceMemory
        
        flops_data = device_capabilities.flops
        if hasattr(flops_data, 'fp32') and hasattr(flops_data, 'fp16') and hasattr(flops_data, 'int8'):
          device_flops = DeviceFlops(fp32=flops_data.fp32, fp16=flops_data.fp16, int8=flops_data.int8)
        elif isinstance(flops_data, dict):
          device_flops = DeviceFlops(fp32=flops_data.get('fp32', 0), fp16=flops_data.get('fp16', 0), int8=flops_data.get('int8', 0))
        else:
          device_flops = DeviceFlops(fp32=0, fp16=0, int8=0)
        
        device_memory = None
        if device_capabilities.HasField('memory_detail'):
          mem = device_capabilities.memory_detail
          device_memory = DeviceMemory(total=mem.total, free=mem.free, used=mem.used)
        
        proper_device_capabilities = DeviceCapabilities(
          model=device_capabilities.model,
          chip=device_capabilities.chip,
          memory=device_capabilities.memory,
          flops=device_flops,
          memory_detail=device_memory
        )
        
        topology.update_node(node_id, proper_device_capabilities)
      
      # response.peer_graph is a map<string, PeerConnections> 
      for from_node_id, peer_connections in response.peer_graph.items():
        for peer_connection in peer_connections.connections:
          topology.add_edge(from_node_id, peer_connection.to_id, peer_connection.description)
      
      topology.active_node_id = response.active_node_id if hasattr(response, 'active_node_id') and response.active_node_id else None
      
      if DEBUG >= 2: print(f"[GRPC] Successfully collected topology from {self.id()}: {len(topology.nodes)} nodes, {len(topology.peer_graph)} peer connections")
      return topology
      
    except asyncio.TimeoutError as e:
      print(f"❌ [GRPC] TimeoutError collecting topology from {self.id()}: {e}")
      print(f"   Peer address: {self.addr()}")
      print(f"   Timeout: not set (gRPC default)")
      traceback.print_exc()
      raise
    except grpc.RpcError as e:
      print(f"❌ [GRPC] RpcError collecting topology from {self.id()}: {e.code()} - {e.details()}")
      print(f"   Peer address: {self.addr()}")
      print(f"   gRPC code: {e.code()}")
      traceback.print_exc()
      raise
    except Exception as e:
      print(f"❌ [GRPC] Error collecting topology from {self.id()}: {type(e).__name__}: {e}")
      print(f"   Peer address: {self.addr()}")
      print(f"   Error details: {str(e)}")
      traceback.print_exc()
      raise

  async def send_result(self, request_id: str, result: List[int], is_finished: bool) -> None:
    await self._ensure_connected()
    tensor = None
    if isinstance(result, np.ndarray):
      tensor = node_service_pb2.Tensor(tensor_data=result.tobytes(), shape=result.shape, dtype=str(result.dtype))
      result = []
    request = node_service_pb2.SendResultRequest(request_id=request_id, result=result, tensor=tensor, is_finished=is_finished)
    await self.stub.SendResult(request)

  async def send_opaque_status(self, request_id: str, status: str) -> None:
    await self._ensure_connected()
    request = node_service_pb2.SendOpaqueStatusRequest(request_id=request_id, status=status)
    await asyncio.wait_for(self.stub.SendOpaqueStatus(request), timeout=30.0)

  def serialize_inference_state(self, inference_state: dict) -> node_service_pb2.InferenceState:
    proto_inference_state = node_service_pb2.InferenceState()
    other_data = {}
    for k, v in inference_state.items():
      # Skip DynamicCache - it will be recreated on the receiving node
      if v is not None and v.__class__.__name__ == 'DynamicCache':
        if DEBUG >= 2: print(f"[GRPCPeerHandle] Skipping DynamicCache in inference_state")
        continue
      # Check if this is an MLX array (only on macOS ARM64)
      if platform.system().lower() == "darwin" and platform.machine().lower() == "arm64":
        if isinstance(v, mx.array):
          np_array = np.array(v)
          tensor_data = node_service_pb2.Tensor(tensor_data=np_array.tobytes(), shape=list(np_array.shape), dtype=str(np_array.dtype))
          proto_inference_state.tensor_data[k].CopyFrom(tensor_data)
        elif isinstance(v, list) and len(v) > 0 and hasattr(v[0], '__class__') and v[0].__class__.__name__ == 'array':
          # Check if list contains MLX arrays
          tensor_list = node_service_pb2.TensorList()
          for tensor in v:
            np_array = np.array(tensor)
            tensor_data = node_service_pb2.Tensor(tensor_data=np_array.tobytes(), shape=list(np_array.shape), dtype=str(np_array.dtype))
            tensor_list.tensors.append(tensor_data)
          proto_inference_state.tensor_list_data[k].CopyFrom(tensor_list)
        elif isinstance(v, np.ndarray):
          # Handle numpy arrays
          tensor_data = node_service_pb2.Tensor(tensor_data=v.tobytes(), shape=list(v.shape), dtype=str(v.dtype))
          proto_inference_state.tensor_data[k].CopyFrom(tensor_data)
        else:
          # For non-tensor data, we'll still use JSON
          other_data[k] = v
      else:
        # On non-macOS systems, handle numpy arrays
        if isinstance(v, np.ndarray):
          tensor_data = node_service_pb2.Tensor(tensor_data=v.tobytes(), shape=list(v.shape), dtype=str(v.dtype))
          proto_inference_state.tensor_data[k].CopyFrom(tensor_data)
        else:
          # For non-tensor data, we'll still use JSON
          other_data[k] = v
    if other_data:
      # Filter out non-serializable objects
      serializable_data = {k: v for k, v in other_data.items() if self._is_json_serializable(v)}
      if serializable_data:
        proto_inference_state.other_data_json = json.dumps(serializable_data)
    return proto_inference_state

  def _is_json_serializable(self, obj) -> bool:
    """检查对象是否可JSON序列化"""
    try:
      json.dumps(obj)
      return True
    except (TypeError, ValueError):
      return False
