"use strict";
import util = require('./util');
import ByteStream = require('./ByteStream');
import attributes = require('./attributes');
import JVM = require('./jvm');
import ConstantPool = require('./ConstantPool');
import ClassData = require('./ClassData');
import threading = require('./threading');
import gLong = require('./gLong');
import ClassLoader = require('./ClassLoader');
import assert = require('./assert');
import enums = require('./enums');
import Monitor = require('./Monitor');
import StringOutputStream = require('./StringOutputStream');
import JVMTypes = require('../includes/JVMTypes');

var trapped_methods: { [clsName: string]: { [methodName: string]: Function } } = {
  'java/lang/ref/Reference': {
    // NOP, because we don't do our own GC and also this starts a thread?!?!?!
    '<clinit>()V': function (thread: threading.JVMThread): void { }
  },
  'java/lang/System': {
    'loadLibrary(Ljava/lang/String;)V': function (thread: threading.JVMThread, libName: JVMTypes.java_lang_String): void {
      var lib = libName.toString();
      if (lib !== 'zip' && lib !== 'net' && lib !== 'nio' && lib !== 'awt' && lib !== 'fontmanager') {
        thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', `no ${lib} in java.library.path`);
      }
    }
  },
  'java/lang/Terminator': {
    'setup()V': function (thread: threading.JVMThread): void {
      // XXX: We should probably fix this; we support threads now.
      // Historically: NOP'd because we didn't support threads.
    }
  },
  'java/util/concurrent/atomic/AtomicInteger': {
    'compareAndSet(II)Z': function (thread: threading.JVMThread, javaThis: JVMTypes.java_util_concurrent_atomic_AtomicInteger, expect: number, update: number): boolean {
      javaThis['java/util/concurrent/atomic/AtomicInteger/value'] = update;
      // always true, because we only have one thread of execution
      // @todo Fix: Actually check expected value!
      return true;
    }
  },
  'java/nio/Bits': {
    'byteOrder()Ljava/nio/ByteOrder;': function (thread: threading.JVMThread): JVMTypes.java_nio_ByteOrder {
      var cls = <ClassData.ReferenceClassData<JVMTypes.java_nio_ByteOrder>> thread.getBsCl().getInitializedClass(thread, 'Ljava/nio/ByteOrder;'),
        cons = <typeof JVMTypes.java_nio_ByteOrder> cls.getConstructor(thread);
      return cons['java/nio/ByteOrder/LITTLE_ENDIAN'];
    },
    'copyToByteArray(JLjava/lang/Object;JJ)V': function (thread: threading.JVMThread, srcAddr: gLong, dst: JVMTypes.JVMArray<any>, dstPos: gLong, length: gLong): void {
      var heap = thread.getThreadPool().getJVM().getHeap(),
        srcStart = srcAddr.toNumber(),
        dstStart: number = dstPos.toNumber(),
        len: number = length.toNumber(),
        i: number,
        arr = dst.array;
      for (i = 0; i < len; i++) {
        arr[dstStart + i] = heap.get_byte(srcStart + i);
      }
    }
  },
  'java/nio/charset/Charset$3': {
    // this is trapped and NOP'ed for speed
    'run()Ljava/lang/Object;': function (thread: threading.JVMThread, javaThis: JVMTypes.java_nio_charset_Charset$3): JVMTypes.java_lang_Object {
      return null;
    }
  }
};

function getTrappedMethod(clsName: string, methSig: string): Function {
  clsName = util.descriptor2typestr(clsName);
  if (trapped_methods.hasOwnProperty(clsName) && trapped_methods[clsName].hasOwnProperty(methSig)) {
    return trapped_methods[clsName][methSig];
  }
  return null;
}

/**
 * Shared functionality between Method and Field objects, as they are
 * represented similarly in class files.
 */
export class AbstractMethodField {
  /**
   * The declaring class of this method or field.
   */
  public cls: ClassData.ReferenceClassData<JVMTypes.java_lang_Object>;
  /**
   * The method / field's slot in the virtual lookup table.
   */
  public slot: number = -1;
  /**
   * The method / field's flags (e.g. static).
   */
  public accessFlags: util.Flags;
  /**
   * The name of the field, without the descriptor or owning class.
   */
  public name: string;
  /**
   * The method/field's type descriptor.
   * e.g.:
   * public String foo; => Ljava/lang/String;
   * public void foo(String bar); => (Ljava/lang/String;)V
   */
  public rawDescriptor: string;
  /**
   * Any attributes on this method or field.
   */
  public attrs: attributes.IAttribute[];

  /**
   * Constructs a field or method object from raw class data.
   */
  constructor(cls: ClassData.ReferenceClassData<JVMTypes.java_lang_Object>, constantPool: ConstantPool.ConstantPool, byteStream: ByteStream) {
    this.cls = cls;
    this.accessFlags = new util.Flags(byteStream.getUint16());
    this.name = (<ConstantPool.ConstUTF8> constantPool.get(byteStream.getUint16())).value;
    this.rawDescriptor = (<ConstantPool.ConstUTF8> constantPool.get(byteStream.getUint16())).value;
    this.attrs = attributes.makeAttributes(byteStream, constantPool);
  }

  /**
   * Sets the field or method's slot. Called once its class is resolved.
   */
  public setSlot(slot: number): void {
    this.slot = slot;
  }

  public getAttribute(name: string): attributes.IAttribute {
    for (var i = 0; i < this.attrs.length; i++) {
      var attr = this.attrs[i];
      if (attr.getName() === name) {
        return attr;
      }
    }
    return null;
  }

  public getAttributes(name: string): attributes.IAttribute[] {
    return this.attrs.filter((attr) => attr.getName() === name);
  }

  /**
   * Get the particular type of annotation as a JVM byte array. Returns null
   * if the annotation does not exist.
   */
  protected getAnnotationType(thread: threading.JVMThread, name: string): JVMTypes.JVMArray<number> {
    var annotation = <{ rawBytes: number[] }> <any> this.getAttribute(name);
    if (annotation === null) {
      return null;
    }
    var byteArrCons = (<ClassData.ArrayClassData<number>> thread.getBsCl().getInitializedClass(thread, '[B')).getConstructor(thread),
      rv = new byteArrCons(thread, 0);
    rv.array = annotation.rawBytes;
    return rv;
  }

  // To satiate TypeScript. Consider it an 'abstract' method.
  public parseDescriptor(raw_descriptor: string): void {
    throw new Error("Unimplemented error.");
  }
}

export class Field extends AbstractMethodField {
  /**
   * The field's full name, which includes the defining class
   * (e.g. java/lang/String/value).
   */
  public fullName: string;

  constructor(cls: ClassData.ReferenceClassData<JVMTypes.java_lang_Object>, constantPool: ConstantPool.ConstantPool, byteStream: ByteStream) {
    super(cls, constantPool, byteStream);
    this.fullName = `${util.descriptor2typestr(cls.getInternalName())}/${this.name}`;
  }

  /**
   * Calls cb with the reflectedField if it succeeds. Calls cb with null if it
   * fails.
   */
  public reflector(thread: threading.JVMThread, cb: (reflectedField: JVMTypes.java_lang_reflect_Field) => void): void {
    var signatureAttr = <attributes.Signature> this.getAttribute("Signature"),
      jvm = thread.getThreadPool().getJVM(),
      bsCl = thread.getBsCl();
    var createObj = (typeObj: JVMTypes.java_lang_Class): JVMTypes.java_lang_reflect_Field => {
      var fieldCls = <ClassData.ReferenceClassData<JVMTypes.java_lang_reflect_Field>> bsCl.getInitializedClass(thread, 'Ljava/lang/reflect/Field;'),
        fieldObj = new (fieldCls.getConstructor(thread))(thread);

      fieldObj['java/lang/reflect/Field/clazz'] = this.cls.getClassObject(thread);
      fieldObj['java/lang/reflect/Field/name'] = jvm.internString(this.name);
      fieldObj['java/lang/reflect/Field/type'] = typeObj;
      fieldObj['java/lang/reflect/Field/modifiers'] = this.accessFlags.getRawByte();
      fieldObj['java/lang/reflect/Field/slot'] = this.slot;
      fieldObj['java/lang/reflect/Field/signature'] = signatureAttr !== null ? util.initString(bsCl, signatureAttr.sig) : null;
      fieldObj['java/lang/reflect/Field/annotations'] = this.getAnnotationType(thread, 'RuntimeVisibleAnnotations');

      return fieldObj;
    };
    // Our field's type may not be loaded, so we asynchronously load it here.
    // In the future, we can speed up reflection by having a synchronous_reflector
    // method that we can try first, and which may fail.
    this.cls.getLoader().resolveClass(thread, this.rawDescriptor, (cdata: ClassData.ClassData) => {
      if (cdata != null) {
        cb(createObj(cdata.getClassObject(thread)));
      } else {
        cb(null);
      }
    });
  }

  private getDefaultFieldValue(): string {
    var desc = this.rawDescriptor;
    if (desc === 'J') return 'gLongZero';
    var c = desc[0];
    if (c === '[' || c === 'L') return 'null';
    return '0';
  }

  /**
   * Outputs a JavaScript field assignment for this field.
   */
  public outputJavaScriptField(jsConsName: string, outputStream: StringOutputStream): void {
    if (this.accessFlags.isStatic()) {
      outputStream.write(`${jsConsName}["${this.fullName}"] = cls._getInitialStaticFieldValue(thread, "${this.name}");\n`);
    } else {
      outputStream.write(`this["${this.fullName}"] = ${this.getDefaultFieldValue()};\n`);
    }
  }
}

export class Method extends AbstractMethodField {
  /**
   * The method's parameters, if any, in descriptor form.
   */
  public parameterTypes: string[];
  /**
   * The method's return type in descriptor form.
   */
  public returnType: string;
  /**
   * The method's signature, e.g. bar()V
   */
  public signature: string;
  /**
   * The method's signature, including defining class; e.g. java/lang/String/bar()V
   */
  public fullSignature: string;
  /**
   * The number of JVM words required to store the parameters (e.g. longs/doubles take up 2 words).
   * Does not include the "this" argument to non-static functions.
   */
  private parameterWords: number;
  /**
   * Code is either a function, or a CodeAttribute.
   * TODO: Differentiate between NativeMethod objects and BytecodeMethod objects.
   */
  private code: any;

  constructor(cls: ClassData.ReferenceClassData<JVMTypes.java_lang_Object>, constantPool: ConstantPool.ConstantPool, byteStream: ByteStream) {
    super(cls, constantPool, byteStream);
    var parsedDescriptor = util.getTypes(this.rawDescriptor), i: number,
      p: string;
    this.signature = this.name + this.rawDescriptor;
    this.fullSignature = `${util.descriptor2typestr(this.cls.getInternalName())}/${this.signature}}`;
    this.returnType = parsedDescriptor.pop();
    this.parameterTypes = parsedDescriptor;
    this.parameterWords = parsedDescriptor.length;

    // Double count doubles / longs.
    for (i = 0; i < this.parameterTypes.length; i++) {
      p = this.parameterTypes[i];
      if (p === 'D' || p === 'J') {
        this.parameterWords++;
      }
    }

    // Initialize 'code' property.
    var clsName = this.cls.getInternalName(),
      methSig = this.name + this.rawDescriptor;

    if (getTrappedMethod(clsName, methSig) !== null) {
      this.code = getTrappedMethod(clsName, methSig);
      this.accessFlags.setNative(true);
    } else if (this.accessFlags.isNative()) {
      if (methSig.indexOf('registerNatives()V', 1) < 0 && methSig.indexOf('initIDs()V', 1) < 0) {
        // The first version of the native method attempts to fetch itself and
        // rewrite itself.
        this.code = (thread: threading.JVMThread) => {
          // Try to fetch the native method.
          var jvm = thread.getThreadPool().getJVM(),
            c = jvm.getNative(clsName, methSig);
          if (c == null) {
            thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', `Native method '${this.getFullSignature()}' not implemented.\nPlease fix or file a bug at https://github.com/plasma-umass/doppio/issues`);
          } else {
            this.code = c;
            return c.apply(this, arguments);
          }
        };
      } else {
        // Stub out initIDs and registerNatives.
        // TODO: Use registerNatives to trigger dynamic native method loading.
        this.code = () => { };
      }
    } else if (!this.accessFlags.isAbstract()) {
      this.code = this.getAttribute('Code');
    }
  }

  public getFullSignature(): string {
    return `${this.cls.getExternalName()}.${this.name}${this.rawDescriptor}`;
  }

  /**
   * Checks if this particular method should be hidden in stack frames.
   * Used by OpenJDK's lambda implementation to hide lambda boilerplate.
   */
  public isHidden(): boolean {
    var rva: attributes.RuntimeVisibleAnnotations = <any> this.getAttribute('RuntimeVisibleAnnotations');
    return rva !== null && rva.isHidden;
  }

  /**
   * Get the number of machine words (32-bit words) required to store the
   * parameters to this function. Includes adding in a machine word for 'this'
   * for non-static functions.
   */
  public getParamWordSize(): number {
    return this.parameterWords;
  }

  public getCodeAttribute(): attributes.Code {
    assert(!this.accessFlags.isNative() && !this.accessFlags.isAbstract());
    return this.code;
  }

  public getNativeFunction(): Function {
    assert(this.accessFlags.isNative() && typeof (this.code) === 'function');
    return this.code;
  }

  /**
   * Resolves all of the classes referenced through this method. Required in
   * order to create its reflection object.
   */
  private _resolveReferencedClasses(thread: threading.JVMThread, cb: (classes: {[ className: string ]: ClassData.ClassData}) => void): void {
    // Start with the return type + parameter types + reflection object types.
    var toResolve: string[] = this.parameterTypes.concat(this.returnType, 'Ljava/lang/reflect/Method;', 'Ljava/lang/reflect/Constructor;'),
      code: attributes.Code = this.code,
      exceptionAttribute = <attributes.Exceptions> this.getAttribute("Exceptions");
    // Exception handler types.
    if (!this.accessFlags.isNative() && !this.accessFlags.isAbstract() && code.exceptionHandlers.length > 0) {
      toResolve.push('Ljava/lang/Throwable;'); // Mimic native Java (in case <any> is the only handler).
      // Filter out the <any> handlers.
      toResolve = toResolve.concat(code.exceptionHandlers.filter((handler) => handler.catchType !== '<any>').map((handler) => handler.catchType));
    }
    // Resolve checked exception types.
    if (exceptionAttribute !== null) {
      toResolve = toResolve.concat(exceptionAttribute.exceptions);
    }

    this.cls.getLoader().resolveClasses(thread, toResolve, cb);
  }

  /**
   * Get a reflection object representing this method.
   */
  public reflector(thread: threading.JVMThread, cb: (reflectedMethod: JVMTypes.java_lang_reflect_Executable) => void): void {
    var bsCl = thread.getBsCl(),
      // Grab the classes required to construct the needed arrays.
      clazzArray = (<ClassData.ArrayClassData<JVMTypes.java_lang_Class>> bsCl.getInitializedClass(thread, '[Ljava/lang/Class;')).getConstructor(thread),
      jvm = thread.getThreadPool().getJVM(),
      // Grab the needed attributes.
      signatureAttr = <attributes.Signature> this.getAttribute("Signature"),
      exceptionAttr = <attributes.Exceptions> this.getAttribute("Exceptions");

    // Retrieve all of the required class references.
    this._resolveReferencedClasses(thread, (classes: { [className: string ]: ClassData.ClassData }) => {
      if (classes === null) {
        return cb(null);
      }

      // Construct the needed objects for the reflection object.
      var clazz = this.cls.getClassObject(thread),
        name = jvm.internString(this.name),
        parameterTypes = new clazzArray(thread, 0),
        returnType = classes[this.returnType].getClassObject(thread),
        exceptionTypes: JVMTypes.JVMArray<JVMTypes.java_lang_Class>,
        modifiers = this.accessFlags.getRawByte(),
        signature = signatureAttr !== null ? jvm.internString(signatureAttr.sig) : null;

      // Prepare the class arrays.
      parameterTypes.array = this.parameterTypes.map((ptype: string) => classes[ptype].getClassObject(thread));
      if (exceptionAttr !== null) {
        exceptionTypes = new clazzArray(thread, 0);
        exceptionTypes.array = exceptionAttr.exceptions.map((eType: string) => classes[eType].getClassObject(thread));
      }

      if (this.name === '<init>') {
        // Constructor object.
        var consCons = (<ClassData.ReferenceClassData<JVMTypes.java_lang_reflect_Constructor>> classes['Ljava/lang/reflect/Constructor;']).getConstructor(thread),
          consObj = new consCons(thread);
        consObj['java/lang/reflect/Constructor/clazz'] = clazz;
        consObj['java/lang/reflect/Constructor/parameterTypes'] = parameterTypes;
        consObj['java/lang/reflect/Constructor/exceptionTypes'] = exceptionTypes;
        consObj['java/lang/reflect/Constructor/modifiers'] = modifiers;
        consObj['java/lang/reflect/Constructor/slot'] = this.slot;
        consObj['java/lang/reflect/Constructor/signature'] = signature;
        consObj['java/lang/reflect/Constructor/annotations'] = this.getAnnotationType(thread, 'RuntimeVisibleAnnotations');
        consObj['java/lang/reflect/Constructor/parameterAnnotations'] = this.getAnnotationType(thread, 'ParameterAnnotations');
      } else {
        // Method object.
        var methodCons = (<ClassData.ReferenceClassData<JVMTypes.java_lang_reflect_Method>>  classes['Ljava/lang/reflect/Method;']).getConstructor(thread),
          methodObj = new methodCons(thread);
        methodObj['java/lang/reflect/Method/clazz'] = clazz;
        methodObj['java/lang/reflect/Method/name'] = name;
        methodObj['java/lang/reflect/Method/parameterTypes'] = parameterTypes;
        methodObj['java/lang/reflect/Method/returnType'] = returnType;
        methodObj['java/lang/reflect/Method/exceptionTypes'] = exceptionTypes;
        methodObj['java/lang/reflect/Method/modifiers'] = modifiers;
        methodObj['java/lang/reflect/Method/slot'] = this.slot;
        methodObj['java/lang/reflect/Method/signature'] = signature;
        methodObj['java/lang/reflect/Method/annotations'] = this.getAnnotationType(thread, 'RuntimeVisibleAnnotations');
        methodObj['java/lang/reflect/Method/annotationDefault'] = this.getAnnotationType(thread, 'AnnotationDefault');
        methodObj['java/lang/reflect/Method/parameterAnnotations'] = this.getAnnotationType(thread, 'ParameterAnnotations');
        cb(methodObj);
      }
    });
  }

  /**
   * Convert the arguments to this method into a form suitable for a native
   * implementation.
   *
   * The JVM uses two parameter slots for double and long values, since they
   * consist of two JVM machine words (32-bits). Doppio stores the entire value
   * in one slot, and stores a NULL in the second.
   *
   * This function strips out these NULLs so the arguments are in a more
   * consistent form. The return value is the arguments to this function without
   * these NULL values. It also adds the 'thread' object to the start of the
   * arguments array.
   */
  public convertArgs(thread: threading.JVMThread, params: any[]): any[] {
    if (this.isSignaturePolymorphic()) {
      // These don't need any conversion, and have arbitrary arguments.
      // Just append the thread object.
      params.unshift(thread);
      return params;
    }
    var convertedArgs = [thread], argIdx = 0, i: number;
    if (!this.accessFlags.isStatic()) {
      convertedArgs.push(params[0]);
      argIdx = 1;
    }
    for (i = 0; i < this.parameterTypes.length; i++) {
      var p = this.parameterTypes[i];
      convertedArgs.push(params[argIdx]);
      argIdx += (p === 'J' || p === 'D') ? 2 : 1;
    }
    return convertedArgs;
  }

  /**
   * Lock this particular method.
   */
  public methodLock(thread: threading.JVMThread, frame: threading.BytecodeStackFrame): Monitor {
    if (this.accessFlags.isStatic()) {
      // Static methods lock the class.
      return this.cls.getClassObject(thread).getMonitor();
    } else {
      // Non-static methods lock the instance.
      return (<JVMTypes.java_lang_Object> frame.locals[0]).getMonitor();
    }
  }

  /**
   * Check if this is a signature polymorphic method.
   * From S2.9:
   * A method is signature polymorphic if and only if all of the following conditions hold :
   * * It is declared in the java.lang.invoke.MethodHandle class.
   * * It has a single formal parameter of type Object[].
   * * It has a return type of Object.
   * * It has the ACC_VARARGS and ACC_NATIVE flags set.
   */
  public isSignaturePolymorphic(): boolean {
    return this.cls.getInternalName() === 'Ljava/lang/invoke/MethodHandle;' &&
      this.accessFlags.isNative() && this.accessFlags.isVarArgs() &&
      this.rawDescriptor === '([Ljava/lang/Object;)Ljava/lang/Object;';
  }

  /**
   * Generates JavaScript code for this particular method.
   * TODO: Move lock logic and such into this function! And other specialization.
   * TODO: Signature polymorphic functions...?
   */
  public outputJavaScriptFunction(jsConsName: string, outStream: StringOutputStream): void {
    var i: number;
    if (this.accessFlags.isStatic()) {
      outStream.write(`${jsConsName}["${this.fullSignature}"] = ${jsConsName}["${this.signature}"] = `);
    } else {
      outStream.write(`${jsConsName}.prototype["${this.fullSignature}"] = ${jsConsName}.prototype["${this.signature}"] = `);
    }
    outStream.write(`(function(method) {
  return function(thread, `);
    // No argfs argument for 0-parameter functions.
    if (this.parameterWords > 0) {
      outStream.write(`args, `);
    }
    // Boilerplate: Required for JS to call into JVM code.
    // XXX: Need to get 'method' somehow. methodLookup??
    outStream.write(`cb) {
    if (typeof cb === 'function') {
      thread.stack.push(new InternalStackFrame(cb));
    }
    thread.stack.push(new ${this.accessFlags.isNative() ? "NativeStackFrame" : "BytecodeStackFrame"}(method, `);
    if (!this.accessFlags.isStatic()) {
      // Non-static functions need to add the implicit 'this' variable to the
      // local variables.
      outStream.write(`[this`);
      // Give the JS engine hints about the size, type, and contents of the array
      // by making it a literal.
      for (i = 0; i < this.parameterWords; i++) {
        outStream.write(`, args[${i}]`);
      }
      outStream.write(`]`);
    } else {
      // Static function doesn't need to mutate the arguments.
      if (this.parameterWords > 0) {
        outStream.write(`args`);
      } else {
        outStream.write(`[]`);
      }
    }
    outStream.write(`));
    thread.setStatus(${enums.ThreadStatus.RUNNABLE});
  };
})(cls.methodLookup("${this.signature}"));\n`);
  }
}
