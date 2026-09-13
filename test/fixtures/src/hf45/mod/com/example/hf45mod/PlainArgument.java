package com.example.hf45mod;
import com.mojang.brigadier.arguments.ArgumentType;
public class PlainArgument implements ArgumentType<String> { public static PlainArgument plain() { return new PlainArgument(); } }
