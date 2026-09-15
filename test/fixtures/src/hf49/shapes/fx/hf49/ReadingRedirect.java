package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// bend 2: the read redirect still READS the buffer (no skip) -> abstain replace-read-not-skipped
@Mixin(FriendlyByteBuf.class) public abstract class ReadingRedirect {
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeByte(I)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf wide(FriendlyByteBuf buf, int count) { return buf.writeInt(count); }
  @Redirect(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;readByte()B"))
  private byte reads(FriendlyByteBuf buf) { return (byte) buf.readInt(); }
  @ModifyVariable(method = "readItem", at = @At("STORE"), ordinal = 0)
  private int count(int v) { return ((FriendlyByteBuf) (Object) this).readInt(); }
}
