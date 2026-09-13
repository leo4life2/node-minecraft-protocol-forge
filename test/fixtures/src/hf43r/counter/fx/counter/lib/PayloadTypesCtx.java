package fx.counter.lib;
import java.util.HashMap; import java.util.Map; import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
/** registry-COUNTER ids: "<ns>:main" + "/" + an AtomicInteger incremented per registration (puzzles-lib shape). */
public abstract class PayloadTypesCtx {
  private static final Map<Class<?>, CustomPacketPayload.Type<?>> MESSAGE_TYPES = new HashMap<>();
  private final AtomicInteger discriminator = new AtomicInteger();
  protected final Identifier channelName;
  protected PayloadTypesCtx(String modId) { this.channelName = Identifier.fromNamespaceAndPath(modId, "main"); }
  protected final synchronized <T extends CustomPacketPayload> CustomPacketPayload.Type<T> registerPayloadType(Class<T> clazz) {
    Identifier id = this.channelName.withSuffix("/" + this.discriminator.getAndIncrement());
    CustomPacketPayload.Type<T> type = new CustomPacketPayload.Type<>(id);
    MESSAGE_TYPES.put(clazz, type);
    return type;
  }
}
