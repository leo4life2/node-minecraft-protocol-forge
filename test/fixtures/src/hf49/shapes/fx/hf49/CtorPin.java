package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf; import net.minecraft.world.item.*;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// green 7 (HF49-r): the count pin is the ItemStack ctor's int argument (@ModifyArg index 1 reading exactly
// one primitive) — the same pin HF35 accepts for the append shape -> derives replace i8 -> i32
@Mixin(FriendlyByteBuf.class) public abstract class CtorPin {
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeByte(I)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf wide(FriendlyByteBuf buf, int count) { return buf.writeInt(count); }
  @Redirect(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;readByte()B"))
  private byte skip(FriendlyByteBuf buf) { return 0; }
  @ModifyArg(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/world/item/ItemStack;<init>(Lnet/minecraft/world/item/Item;I)V"), index = 1)
  private int count(int v) { return ((FriendlyByteBuf) (Object) this).readInt(); }
}
