package fx.ver.lib;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
public interface PacketType {
  Identifier id();
  default CustomPacketPayload.Type<NetworkPayload> type(Identifier channel) {
    return new CustomPacketPayload.Type<>(channel.withSuffix("/" + id().getNamespace() + "/" + id().getPath()));
  }
}
