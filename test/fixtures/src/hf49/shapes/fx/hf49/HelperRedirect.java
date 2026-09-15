package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// bend 8 (HF49-r): the read redirect returns a helper call (invokestatic, no buffer read) — not a provable
// constant return -> abstain replace-read-not-skipped with the measured detail (no recognised primitive read)
@Mixin(FriendlyByteBuf.class) public abstract class HelperRedirect {
  private static byte zero() { return 0; }
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeByte(I)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf wide(FriendlyByteBuf buf, int count) { return buf.writeInt(count); }
  @Redirect(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;readByte()B"))
  private byte skip(FriendlyByteBuf buf) { return zero(); }
  @ModifyVariable(method = "readItem", at = @At("STORE"), ordinal = 0)
  private int count(int v) { return ((FriendlyByteBuf) (Object) this).readInt(); }
}
