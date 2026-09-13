package net.neoforged.fml.event.lifecycle;
import java.util.concurrent.CompletableFuture;
public class FMLCommonSetupEvent { public CompletableFuture<Void> enqueueWork(Runnable work) { return CompletableFuture.runAsync(work); } }
