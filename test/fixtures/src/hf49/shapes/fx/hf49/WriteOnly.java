package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// bend 5: a write redirect with no read half -> abstain (unpaired: 0 skips, 0 value reads)
@Mixin(FriendlyByteBuf.class) public abstract class WriteOnly {
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeByte(I)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf wide(FriendlyByteBuf buf, int count) { return buf.writeInt(count); }
}
