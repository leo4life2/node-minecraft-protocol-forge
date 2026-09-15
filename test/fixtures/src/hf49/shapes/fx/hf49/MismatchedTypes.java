package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// bend 3: write i32, read i16 -> abstain field-mismatch
@Mixin(FriendlyByteBuf.class) public abstract class MismatchedTypes {
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeByte(I)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf wide(FriendlyByteBuf buf, int count) { return buf.writeInt(count); }
  @Redirect(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;readByte()B"))
  private byte skip(FriendlyByteBuf buf) { return 0; }
  @ModifyVariable(method = "readItem", at = @At("STORE"), ordinal = 0)
  private int count(int v) { return ((FriendlyByteBuf) (Object) this).readShort(); }
}
