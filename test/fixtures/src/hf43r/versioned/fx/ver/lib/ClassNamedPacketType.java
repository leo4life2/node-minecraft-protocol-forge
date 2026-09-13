package fx.ver.lib;
import java.util.Locale;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
/** the CLASS-NAME variant: the packet id is the message class's simple name */
public interface ClassNamedPacketType<T> extends ClientboundPacketType<T> {
  Class<T> clazz();
  default Identifier id() { return Identifier.parse("fixture:unused"); }
  @Override default CustomPacketPayload.Type<NetworkPayload> type(Identifier channel) {
    return new CustomPacketPayload.Type<>(channel.withSuffix("/" + clazz().getSimpleName().toLowerCase(Locale.ROOT)));
  }
}
