package com.example.hf45mod;
import net.minecraft.commands.synchronization.ArgumentTypeInfo;
import net.minecraft.commands.synchronization.ArgumentTypeInfos;
import net.minecraft.commands.synchronization.SingletonArgumentInfo;
import net.neoforged.neoforge.registries.DeferredRegister;
import java.util.function.Supplier;
public class Hf45Mod {
  public static final DeferredRegister<ArgumentTypeInfo<?, ?>> ARGS = DeferredRegister.create("minecraft:command_argument_type", "hf45mod");
  public static final Supplier<VarintArgument.Info> VARINT = ARGS.register("varint_thing", () -> ArgumentTypeInfos.registerByClass(VarintArgument.class, new VarintArgument.Info()));
  public static final Supplier<NullableArgument.Info> NULLABLE = ARGS.register("nullable_thing", () -> ArgumentTypeInfos.registerByClass(NullableArgument.class, new NullableArgument.Info()));
  public static final Supplier<BranchArgument.Info> BRANCH = ARGS.register("branch_thing", () -> ArgumentTypeInfos.registerByClass(BranchArgument.class, new BranchArgument.Info()));
  public static final Supplier<SingletonArgumentInfo<PlainArgument>> PLAIN = ARGS.register("plain_thing", () -> ArgumentTypeInfos.registerByClass(PlainArgument.class, SingletonArgumentInfo.contextFree(PlainArgument::plain)));
}
